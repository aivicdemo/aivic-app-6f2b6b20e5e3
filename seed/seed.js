#!/usr/bin/env node
/**
 * DynamoDB Seeder — 営業支援システムの構築
 * 使い方: node seed/seed.js [--table テーブル名]
 *
 * 前提条件:
 *   - AWS credentials が設定済み（環境変数 or ~/.aws/credentials）
 *   - AWS_REGION 環境変数（デフォルト: ap-northeast-1）
 *   - api/data.json が存在すること
 */
const { DynamoDBClient, PutItemCommand, DeleteItemCommand, ScanCommand } = require("@aws-sdk/client-dynamodb");
const { marshall } = require("@aws-sdk/util-dynamodb");
const fs = require("fs");
const path = require("path");

const region = process.env.AWS_REGION || "ap-northeast-1";
const client = new DynamoDBClient({ region });

// テーブルマッピング（DynamoDBの実際のテーブル名に合わせて変更してください）
const TABLE_MAP = {
  "市場価格データ",
  "月次集計データ",
  "購買パターン分析結果",
  "価格戦略分析結果",
  "顧客別単価比較分析結果",
  "分析レポート",
  "システム操作履歴"
};

async function seedTable(tableName, records) {
  console.log(`\nSeeding ${tableName} (${records.length} records)...`);
  let success = 0;
  for (const record of records) {
    try {
      await client.send(new PutItemCommand({
        TableName: tableName,
        Item: marshall(record, { removeUndefinedValues: true }),
      }));
      success++;
    } catch (err) {
      console.error(`  Failed to insert record ${record.id || JSON.stringify(record).slice(0, 40)}: ${err.message}`);
    }
  }
  console.log(`  Done: ${success}/${records.length} records inserted.`);
}

async function main() {
  const dataPath = path.join(__dirname, "..", "api", "data.json");
  if (!fs.existsSync(dataPath)) {
    console.error("api/data.json が見つかりません。先にファイルを配置してください。");
    process.exit(1);
  }

  const data = JSON.parse(fs.readFileSync(dataPath, "utf8"));
  const targetTable = process.argv.find((a) => a.startsWith("--table="))?.split("=")[1]
    || process.argv[process.argv.indexOf("--table") + 1];

  for (const [key, tableName] of Object.entries(TABLE_MAP)) {
    if (targetTable && tableName !== targetTable && key !== targetTable) continue;
    const records = data[key];
    if (!Array.isArray(records)) {
      console.warn(`Skipping ${key}: data not found or not an array`);
      continue;
    }
    await seedTable(String(tableName), records);
  }

  console.log("\nSeeding complete.");
}

main().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
