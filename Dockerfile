FROM node:18-slim

# 1. Instalacja systemu i niezbędnych narzędzi
# FFmpeg to silnik montażu, dumb-init dba o procesy
RUN apt-get update && \
    apt-get install -y ffmpeg dumb-init && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

# 2. Ustawienie środowiska produkcyjnego
ENV NODE_ENV=production

# 3. Katalog roboczy aplikacji
WORKDIR /app

# 4. Kopiowanie plików definicji pakietów
COPY package*.json ./

# 5. Instalacja zależności
# Używamy 'install', ponieważ Render często nie ma pliku package-lock.json w repozytorium
RUN npm install --omit=dev

# 6. Kopiowanie całego kodu źródłowego
COPY . .

# 7. Utworzenie folderu na pliki tymczasowe (pobieranie z Supabase)
RUN mkdir -p temp && chmod 777 temp

# 8. Komenda startowa przez dumb-init
CMD ["dumb-init", "node", "index.js"]
