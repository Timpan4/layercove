#!/bin/sh
set -e

cd frontend
npx tsc
npm run lint
npm run test:run
cd ..
