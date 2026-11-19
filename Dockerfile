# plan: DSh Tagger 独立 web 服务的容器镜像（零运行时依赖，纯 node 标准库）
# 构建：docker build -t dsh-tagger:0.2.0 .
# 运行：docker run --rm -p 7789:7789 -v tagger-data:/data dsh-tagger:0.2.0
FROM node:22-alpine

LABEL org.opencontainers.image.title="DSh Tagger" \
      org.opencontainers.image.description="白话 → WD + Camie 标签 → ComfyUI 的锻造台（独立 web 服务）" \
      org.opencontainers.image.version="0.2.0" \
      org.opencontainers.image.licenses="MIT"

ENV NODE_ENV=production \
    DSH_TAGGER_DATA=/data \
    DSH_TAGGER_HOST=0.0.0.0 \
    DSH_TAGGER_PORT=7789

WORKDIR /app

# 这个项目没有任何运行时依赖（只用 node 标准库），所以不需要 npm install，
# 也就不需要联网装包：镜像构建只做文件拷贝，离线也能构建。
COPY package.json index.js client.js icon.svg ./
COPY client ./client
COPY lib ./lib
COPY server ./server
COPY data ./data
COPY locale ./locale
COPY types ./types
COPY docs/API.md docs/PERF.md ./docs/
COPY README.md INSTALL.md ./

# 数据目录（settings.json / 标签缓存）挂卷，容器重建不丢配置
RUN mkdir -p /data && chown -R node:node /data /app
VOLUME ["/data"]

USER node
EXPOSE 7789

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -q -O- http://127.0.0.1:7789/tagger/api/health >/dev/null 2>&1 || exit 1

CMD ["node", "server/standalone.mjs", "--host", "0.0.0.0", "--port", "7789", "--data-dir", "/data"]