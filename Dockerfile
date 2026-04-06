FROM node:20-slim

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY server/ ./server/
COPY dist/ ./dist/

ENV NODE_ENV=production
ENV OCTIS_API_PORT=8080
ENV PG_HOST=34.95.39.115
ENV PG_DB=beatimo_warehouse
ENV PG_USER=postgres

EXPOSE 8080

CMD ["node", "server/index.js"]
