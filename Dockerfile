# Apify base image — includes Chromium + Playwright pre-installed
FROM apify/actor-node-playwright-chrome:20

# Copy package files and install dependencies
# --ignore-scripts skips playwright's browser download (already in base image)
COPY package*.json ./
RUN npm --quiet set progress=false \
    && npm install --omit=dev --omit=optional --ignore-scripts \
    && echo "Dependencies installed."

# Copy source
COPY . ./

CMD npm start
