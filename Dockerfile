# 数码资产持有成本管理系统 - Docker 镜像
# 构建: docker build -t asset-tracker .
# 运行: docker run -d -p 5678:5678 -v $(pwd)/data:/app/data --name asset-tracker asset-tracker
FROM python:3.12-slim

WORKDIR /app

# 仅安装运行时依赖（无需 pyinstaller / pystray / pillow）
COPY requirements-docker.txt .
RUN pip install --no-cache-dir -r requirements-docker.txt

# 拷贝应用代码与前端资源
COPY app.py .
COPY templates ./templates
COPY static ./static

# 纯服务模式：不开浏览器、无托盘；数据库写入 /app/data（建议挂载卷持久化）
ENV HEADLESS=1
ENV DATA_DIR=/app/data
ENV PORT=5678

EXPOSE 5678

CMD ["python", "app.py"]
