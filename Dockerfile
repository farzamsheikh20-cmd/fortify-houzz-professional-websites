FROM apify/actor-node-playwright-chrome:20
COPY --chown=myuser:myuser package*.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY --chown=myuser:myuser . ./
CMD ["npm", "start"]
