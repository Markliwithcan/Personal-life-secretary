"""One-way secretary snapshot -> an authenticated CalDAV VTODO collection.

No task database writes and no completion feedback from the phone. Credentials
belong in a private .local.json file, never in URLs or logs.
"""
import argparse
import base64
import datetime as dt
import hashlib
import json
import re
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

import vobject
from dateutil.tz import tzutc
from defusedxml import ElementTree as ET

NS = {'d': 'DAV:', 'c': 'urn:ietf:params:xml:ns:caldav'}
MARKER = re.compile(r'\[secretary:([a-f0-9]{32}):([a-f0-9]{64}):([1-9][0-9]*)\]')


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


class HTTP:
    def __init__(self, url, authorization):
        parsed = urllib.parse.urlsplit(url)
        if parsed.username or parsed.password or parsed.query or parsed.fragment:
            raise ValueError('INVALID_ENDPOINT')
        if parsed.scheme != 'https' and not (parsed.scheme == 'http' and parsed.hostname in ('127.0.0.1', '::1')):
            raise ValueError('TLS_OR_LOOPBACK_REQUIRED')
        self.url, self.authorization = url, authorization
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect)

    def request(self, method, suffix='', body=None, headers=None):
        h = {'Authorization': self.authorization, 'Content-Type': 'application/xml; charset=utf-8'}
        h.update(headers or {})
        req = urllib.request.Request(self.url + suffix, method=method, headers=h,
                                     data=body.encode('utf-8') if body is not None else None)
        try:
            response = self.opener.open(req, timeout=20)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            data = response.read(4 * 1024 * 1024 + 1)
            if len(data) > 4 * 1024 * 1024:
                raise ValueError('RESPONSE_TOO_LARGE')
            return response.status, data, response.headers


def timestamp(value):
    parsed = dt.datetime.fromisoformat(value.replace('Z', '+00:00'))
    if parsed.tzinfo is None:
        raise ValueError('TIMEZONE_REQUIRED')
    return parsed.astimezone(tzutc())


def validate_snapshot(data, cfg):
    if data.get('version') != 1 or not isinstance(data.get('items'), list) or len(data['items']) > 5000:
        raise ValueError('INVALID_SNAPSHOT')
    items = {}
    for item in data['items']:
        marker = item.get('marker', '')
        match = MARKER.fullmatch(marker)
        if not match or match[1] != cfg['namespace'] or match[2] not in cfg['scopes']:
            raise ValueError('SCOPE_MISMATCH')
        if marker in items or type(item.get('active')) is not bool:
            raise ValueError('INVALID_ITEM')
        state = item.get('state')
        if state not in ('open', 'pending_cancel', 'done', 'cancelled') or item['active'] != (state in ('open', 'pending_cancel')):
            raise ValueError('INVALID_STATE')
        if not isinstance(item.get('title'), str) or not item['title'].strip() or len(item['title']) > 10000:
            raise ValueError('INVALID_TITLE')
        # Require the extended contract. Missing fields must never clear alarms.
        when = item.get('reminder_at')
        if not isinstance(when, str) or (when and state != 'open'):
            raise ValueError('INVALID_REMINDER_TIME')
        if when:
            timestamp(when)
        items[marker] = item
    return items


def uid(marker):
    return hashlib.sha256(marker.encode()).hexdigest() + '@secretary.local'


def fingerprint(item):
    # Do not use the API's future-only alarm field: reaching a due time is not an edit.
    content = [item['title'], item['state'], item['reminder_at']]
    return hashlib.sha256(json.dumps(content, ensure_ascii=False).encode()).hexdigest()


def render(item, now, previous=None):
    calendar = vobject.iCalendar()
    task = calendar.add('vtodo')
    task.add('uid').value = uid(item['marker'])
    task.add('summary').value = item['title']
    task.add('description').value = item['marker'] + '\nversion:' + fingerprint(item) + '\n完成情况请在飞书确认。'
    task.add('dtstamp').value = now
    task.add('last-modified').value = now
    task.add('created').value = previous.created.value if previous and 'created' in previous.contents else now
    task.add('sequence').value = str(int(previous.sequence.value) + 1) if previous and 'sequence' in previous.contents else '0'
    task.add('status').value = 'NEEDS-ACTION'
    task.add('percent-complete').value = '0'
    if item['reminder_at']:
        due = timestamp(item['reminder_at'])
        task.add('dtstart').value = due
        task.add('due').value = due
        # Importing an overdue task must not cause a burst of historical alarms.
        if due > now:
            alarm = task.add('valarm')
            alarm.add('action').value = 'DISPLAY'
            alarm.add('description').value = item['title']
            alarm.add('trigger').value = dt.timedelta(0)
    return calendar.serialize()


def read_collection(dav):
    query = '''<c:calendar-query xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:d="DAV:"><d:prop><d:getetag/><c:calendar-data/></d:prop><c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VTODO"/></c:comp-filter></c:filter></c:calendar-query>'''
    code, body, _ = dav.request('REPORT', body=query, headers={'Depth': '1'})
    if code != 207:
        raise ValueError('CALDAV_READ_FAILED')
    rows = {}
    for row in ET.fromstring(body).findall('d:response', NS):
        props = [p.find('d:prop', NS) for p in row.findall('d:propstat', NS) if ' 200 ' in p.findtext('d:status', '', NS)]
        for prop in props:
            if prop is None or not prop.findtext('c:calendar-data', '', NS):
                continue
            task = vobject.readOne(prop.findtext('c:calendar-data', '', NS)).vtodo
            task_uid = task.uid.value
            if task_uid in rows:
                raise ValueError('DUPLICATE_UID')
            # Only direct child resources may be modified, never paths from untrusted task data.
            href = row.findtext('d:href', '', NS)
            expected = urllib.parse.urlsplit(dav.url).path
            if not href.startswith(expected) or '/' in href[len(expected):] or not href[len(expected):]:
                raise ValueError('INVALID_RESOURCE_PATH')
            etag = prop.findtext('d:getetag', '', NS)
            if not etag:
                raise ValueError('ETAG_REQUIRED')
            rows[task_uid] = {'task': task, 'suffix': href[len(expected):], 'etag': etag}
    return rows


def reconcile(items, existing, cfg, dav, now):
    counts = {'created': 0, 'updated': 0, 'removed': 0, 'unchanged': 0}
    desired = {uid(marker): item for marker, item in items.items() if item['active']}
    for task_uid, item in desired.items():
        old = existing.get(task_uid)
        version = 'version:' + fingerprint(item)
        description = old['task'].description.value if old and 'description' in old['task'].contents else ''
        if old and description.splitlines()[:2] == [item['marker'], version]:
            counts['unchanged'] += 1
            continue
        body = render(item, now, old['task'] if old else None)
        headers = {'Content-Type': 'text/calendar; charset=utf-8'}
        headers['If-Match' if old else 'If-None-Match'] = old['etag'] if old else '*'
        code, _, _ = dav.request('PUT', old['suffix'] if old else task_uid.split('@')[0] + '.ics', body, headers)
        if code not in (201, 204):
            raise ValueError('CALDAV_UPDATE_FAILED')
        counts['updated' if old else 'created'] += 1
    for task_uid, old in existing.items():
        description = old['task'].description.value if 'description' in old['task'].contents else ''
        marker = description.splitlines()[0] if description else ''
        match = MARKER.fullmatch(marker)
        owned = match and match[1] == cfg['namespace'] and match[2] in cfg['scopes'] and uid(marker) == task_uid
        if owned and task_uid not in desired:
            code, _, _ = dav.request('DELETE', old['suffix'], headers={'If-Match': old['etag']})
            if code not in (204, 404):
                raise ValueError('CALDAV_DELETE_FAILED')
            counts['removed'] += 1
    return counts


def sync(cfg):
    source = HTTP(cfg['source']['url'], cfg['source']['authorization'])
    code, body, _ = source.request('GET')
    if code != 200:
        raise ValueError('SOURCE_UNAVAILABLE')
    # Validate the entire snapshot before any mutation, including deletions.
    items = validate_snapshot(json.loads(body), cfg)
    auth = 'Basic ' + base64.b64encode((cfg['caldav']['username'] + ':' + cfg['caldav']['password']).encode()).decode()
    dav = HTTP(cfg['caldav']['url'], auth)
    return reconcile(items, read_collection(dav), cfg, dav, dt.datetime.now(tzutc()).replace(microsecond=0))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('config', type=Path)
    args = parser.parse_args()
    try:
        config = json.loads(args.config.read_text(encoding='utf-8-sig'))
        print(json.dumps({'status': 'ok', **sync(config)}))
    except Exception as error:
        reason = str(error) if isinstance(error, ValueError) and re.fullmatch('[A-Z_]+', str(error)) else type(error).__name__
        print(json.dumps({'status': 'error', 'reason': reason}))
        raise SystemExit(1)
