FROM node:18-alpine

# 设置时区
RUN apk add --no-cache tzdata
ENV TZ=Asia/Shanghai

WORKDIR /app

# 只复制运行需要的文件
COPY cpa_config.mjs cpa_server.mjs dashboard.html ./

# 数据目录（挂载 volume 持久化）
ENV DATA_DIR=/app/data
VOLUME /app/data

EXPOSE 3456

CMD ["node", "cpa_server.mjs"]
