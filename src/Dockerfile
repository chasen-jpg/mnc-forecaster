FROM node:20-slim
WORKDIR /app
ENV NODE_ENV=production

COPY package.json ./
# Use npm ci if a lockfile exists, otherwise npm install
RUN npm install --omit=dev

COPY src ./src

EXPOSE 3000
CMD ["npm","start"]
