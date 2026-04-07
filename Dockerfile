FROM node:20-alpine

WORKDIR /app

# Install deps
COPY package*.json ./
RUN npm install --omit=dev

# Copy server + built frontend
COPY server/ ./server/
COPY dist/ ./dist/

# Serve static files from dist/ via Express
ENV PORT=8080
ENV OCTIS_API_PORT=8080

# Add static file serving to server
EXPOSE 8080

CMD ["node", "server/index.js"]
