import copy
import datetime as dt
import importlib.util
import unittest
from pathlib import Path
from unittest.mock import patch

import vobject
from dateutil.tz import tzutc

spec = importlib.util.spec_from_file_location('caldav_sync', Path(__file__).with_name('caldav-sync.py'))
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)
NOW = dt.datetime(2026, 10, 22, 12, 0, tzinfo=tzutc())
CFG = {'namespace': 'b'*32, 'scopes': ['a'*64], 'source': {'url': 'http://127.0.0.1:8788/v1/apple-reminders', 'authorization': 'Bearer test'}}
ITEM = {'marker': '[secretary:'+CFG['namespace']+':'+'a'*64+':1]', 'title': '虚构事项', 'state': 'open', 'active': True, 'reminder_at': '2026-10-22T12:10:00Z'}


class DAV:
    def __init__(self): self.calls = []
    def request(self, method, suffix='', body=None, headers=None):
        self.calls.append((method, suffix, body, headers))
        return (204 if method == 'DELETE' or 'If-Match' in (headers or {}) else 201), b'', {}


def existing(item=ITEM):
    task = vobject.readOne(bridge.render(item, NOW)).vtodo
    return {bridge.uid(item['marker']): {'task': task, 'suffix': 'owned.ics', 'etag': '"one"'}}


class CalDAVTests(unittest.TestCase):
    def test_validate_full_snapshot_rejects_foreign_scope_duplicate_and_missing_time(self):
        for bad in ({**ITEM, 'marker': ITEM['marker'].replace('a'*64, 'c'*64)},
                    {k: v for k, v in ITEM.items() if k != 'reminder_at'},
                    {**ITEM, 'active': 'false'}):
            with self.assertRaises(ValueError): bridge.validate_snapshot({'version': 1, 'items': [ITEM, bad]}, CFG)
        with self.assertRaises(ValueError): bridge.validate_snapshot({'version': 1, 'items': [ITEM, ITEM]}, CFG)

    def test_unchanged_alarm_survives_due_time_and_phone_completion_does_not_write_back(self):
        rows = existing()
        task = next(iter(rows.values()))['task']
        task.status.value = 'COMPLETED'  # Phone edits stay on the phone until source changes.
        dav = DAV()
        result = bridge.reconcile({ITEM['marker']: ITEM}, rows, CFG, dav, NOW+dt.timedelta(hours=1))
        self.assertEqual(result['unchanged'], 1)
        self.assertEqual(dav.calls, [])
        self.assertIn('valarm', task.contents)

    def test_changes_keep_uid_and_clear_old_alarm_for_unknown_time_and_pending_cancel(self):
        for changes in ({'reminder_at': ''}, {'state': 'pending_cancel', 'reminder_at': '', 'title': '虚构事项（拟取消）'}):
            item = {**ITEM, **changes}
            dav = DAV()
            bridge.reconcile({item['marker']: item}, existing(), CFG, dav, NOW)
            self.assertEqual(len(dav.calls), 1)
            self.assertEqual(dav.calls[0][0], 'PUT')
            task = vobject.readOne(dav.calls[0][2]).vtodo
            self.assertEqual(task.uid.value, bridge.uid(ITEM['marker']))
            self.assertNotIn('valarm', task.contents)
            self.assertNotIn('due', task.contents)

    def test_initial_overdue_import_has_no_alarm_but_future_time_does(self):
        for when, alarm in ((NOW-dt.timedelta(hours=1), False), (NOW+dt.timedelta(hours=1), True)):
            item = {**ITEM, 'reminder_at': when.isoformat()}
            task = vobject.readOne(bridge.render(item, NOW)).vtodo
            self.assertEqual('valarm' in task.contents, alarm)
            self.assertEqual(task.due.value, when)

    def test_completion_and_missing_source_only_remove_owned_items(self):
        for items in ({}, {ITEM['marker']: {**ITEM, 'state': 'done', 'active': False, 'reminder_at': ''}}):
            rows = existing()
            unrelated = copy.deepcopy(next(iter(rows.values())))
            unrelated['task'].uid.value = 'handwritten'
            unrelated['task'].description.value = '手机手写事项'
            rows['handwritten'] = unrelated
            dav = DAV()
            result = bridge.reconcile(items, rows, CFG, dav, NOW)
            self.assertEqual(result['removed'], 1)
            self.assertEqual(dav.calls[0][1], 'owned.ics')
            self.assertEqual(len(dav.calls), 1)

    def test_source_failure_never_reaches_caldav_or_deletes_anything(self):
        with patch.object(bridge, 'HTTP') as http:
            http.return_value.request.return_value = (503, b'{"error":"unavailable"}', {})
            with self.assertRaisesRegex(ValueError, 'SOURCE_UNAVAILABLE'): bridge.sync(CFG)
            self.assertEqual(http.call_count, 1)
            self.assertEqual(http.return_value.request.call_count, 1)


if __name__ == '__main__': unittest.main()
