FROM mcr.microsoft.com/playwright:v1.60.0-jammy

RUN apt-get update \
  && apt-get install -y ca-certificates curl \
  && curl -fsSL https://deb.nodesource.com/setup_24.x | bash - \
  && apt-get install -y nodejs \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
ENV NODE_ENV=production

COPY package*.json ./
RUN npm install --omit=dev

COPY src ./src
COPY public ./public

RUN mkdir -p /app/data
EXPOSE 18994
CMD ["node", "src/server.js"]

