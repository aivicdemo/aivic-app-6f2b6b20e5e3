// AIVIC Backend Configuration
// AIVIC_APP_URL 環境変数が設定されている場合は自動セットされます
// 未設定の場合: REPLACE_WITH_API_URL を AIVIC アプリの URL（例: https://your-app.amplifyapp.com）に書き換えてください

window.AIVIC_API_URL = "REPLACE_WITH_API_URL";
window.AIVIC_TABLES = {
  "市場価格データ": 0,
  "月次集計データ": 1,
  "購買パターン分析結果": 2,
  "価格戦略分析結果": 3,
  "顧客別単価比較分析結果": 4,
  "分析レポート": 5,
  "システム操作履歴": 6
};
