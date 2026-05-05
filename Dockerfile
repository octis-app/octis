FROM node:20-slim AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .

# Build the frontend (Vite)
ARG VITE_CLERK_PUBLISHABLE_KEY=pk_test_b3JnYW5pYy1oaXBwby0xNC5jbGVyay5hY2NvdW50cy5kZXYk
ARG VITE_API_URL=
ENV VITE_CLERK_PUBLISHABLE_KEY=$VITE_CLERK_PUBLISHABLE_KEY
ENV VITE_API_URL=$VITE_API_URL

RUN npm run build

# Production image
FROM node:20-slim

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY server/ ./server/
COPY --from=builder /app/dist ./dist/

ENV NODE_ENV=production
ENV OCTIS_API_PORT=8080
ENV PG_HOST=34.95.39.115
ENV PG_DB=beatimo_warehouse
ENV PG_USER=postgres

EXPOSE 8080

CMD ["node", "server/index.js"]
