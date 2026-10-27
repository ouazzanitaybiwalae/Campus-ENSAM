# ---- 1) build the React app ----
FROM node:20-slim AS web
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY index.html vite.config.js AdminChat.jsx ./
COPY src ./src
COPY public ./public
RUN npm run build

# ---- 2) API + built site in ONE service ----
FROM python:3.12-slim
WORKDIR /app
ENV PYTHONUNBUFFERED=1
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY server ./server
COPY data ./data
COPY --from=web /app/dist ./dist
ENV PORT=8000
EXPOSE 8000
CMD ["sh", "-c", "uvicorn server.main:app --host 0.0.0.0 --port ${PORT}"]
