# 数码资产持有成本管理系统 - Docker 镜像
# 构建: docker build -t assettracker:1.0.0 .
# 运行: docker run -d -p 5678:5678 -v $(pwd)/data:/app/data --name assettracker assettracker:1.0.0
#
# 国内网络拉不动可覆盖两个参数：
#   docker build \
#     --build-arg BASE_IMAGE=docker.m.daocloud.io/library/python:3.12-slim \
#     --build-arg PIP_INDEX_URL=https://pypi.tuna.tsinghua.edu.cn/simple \
#     -t assettracker:1.0.0 .
ARG BASE_IMAGE=python:3.12-slim
FROM ${BASE_IMAGE}

# 只对后面的 RUN 生效；默认官方源，可用 --build-arg 换镜像源
ARG PIP_INDEX_URL=https://pypi.org/simple

WORKDIR /app

# 仅安装运行时依赖（无需 pyinstaller / pystray / pillow）
COPY requirements-docker.txt .
RUN pip install --no-cache-dir --index-url "${PIP_INDEX_URL}" -r requirements-docker.txt

# 拷贝应用代码与前端资源
# 注意：at/ 是后端包，漏了它镜像会在 import 时直接挂掉
COPY VERSION .
COPY app.py .
COPY at ./at
COPY templates ./templates
COPY static ./static

# 纯服务模式：不开浏览器、无托盘；数据库写入 /app/data（建议挂载卷持久化）
ENV HEADLESS=1
ENV DATA_DIR=/app/data
ENV PORT=5678

EXPOSE 5678

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:5678/api/health').status == 200 else 1)"

CMD ["python", "app.py"]
