#!/usr/bin/env sh
# Builds the site with the Amazon Location map key and publishes it to S3 + CloudFront.
# Run after `npm run deploy -w infra` (which writes data/cache/outputs.json).
set -eu
cd "$(dirname "$0")/.."
out=data/cache/outputs.json
val() { node -e "console.log(require('./$out').AfterHours['$1'])"; }
BUCKET=$(val SiteBucket)
DIST=$(val DistributionId)
KEY_NAME=$(val MapKeyName)
export VITE_LOCATION_KEY=$(aws location describe-key --key-name "$KEY_NAME" --query Key --output text)
export VITE_LOCATION_REGION=us-east-1

npm run build -w web
# Hashed assets cache for a year; pages and data revalidate.
aws s3 sync web/dist/assets "s3://$BUCKET/assets" --cache-control "public,max-age=31536000,immutable" --delete
aws s3 sync web/dist "s3://$BUCKET" --exclude "assets/*" --exclude "data/nyc/changes.json" --exclude "*.geojson" --cache-control "public,max-age=300" --delete
# S3 has no type for .geojson, and CloudFront only compresses known text types: send it as JSON.
aws s3 sync web/dist "s3://$BUCKET" --exclude "*" --include "*.geojson" --content-type application/json --cache-control "public,max-age=300"
aws cloudfront create-invalidation --distribution-id "$DIST" --paths "/*" --query Invalidation.Id --output text
echo "Published to https://$(aws cloudfront get-distribution --id "$DIST" --query Distribution.DomainName --output text)"
