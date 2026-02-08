FROM node:18-slim
RUN apt-get update && apt-get install -y ffmpeg dumb-init && apt-get clean && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .
RUN mkdir -p temp && chmod 777 temp
CMD ["dumb-init", "node", "index.js"]
