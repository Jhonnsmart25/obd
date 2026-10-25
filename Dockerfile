FROM node:20-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev && npm cache clean --force
COPY . .
# Si usas un Disco persistente de Render, móntalo en /var/data y define DATA_DIR=/var/data
RUN mkdir -p /app/data-store && chown -R node:node /app/data-store
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:${PORT:-3000}/healthz || exit 1
CMD ["node", "server.js"]
