FROM node:24-alpine

WORKDIR /app
ENV NODE_ENV=production

COPY package*.json ./
RUN npm ci --omit=dev

COPY server.js ./
COPY public/index.html ./public/
COPY public/main.js ./public/
COPY public/styles.css ./public/
COPY public/context.md ./public/

EXPOSE 8080
CMD ["node", "server.js"]
