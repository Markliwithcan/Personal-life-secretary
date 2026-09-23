FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-venv ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY requirements-cloud.txt ./
RUN python3 -m venv /opt/venv && /opt/venv/bin/pip install --no-cache-dir -r requirements-cloud.txt
COPY *.mjs parse_sheet.py ./
ENV NODE_ENV=production ASSISTANT_CONFIG_DIR=/config ASSISTANT_DATA_DIR=/data ASSISTANT_PYTHON=/opt/venv/bin/python
RUN mkdir /data /config && chown node:node /data /config
USER node
CMD ["node", "feishu-bot.mjs"]
