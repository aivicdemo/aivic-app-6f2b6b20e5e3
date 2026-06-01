import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand, GetCommand, PutCommand, DeleteCommand, BatchWriteCommand } from '@aws-sdk/lib-dynamodb';
import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { hasPermission, validateRole, Role } from './rbac';
import { randomUUID } from 'crypto';

const client = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(client);
const TABLE_NAME = process.env.MAIN_TABLE!;

interface AuditLog {
  pk: string;
  sk: string;
  action: string;
  userId: string;
  timestamp: string;
  details: any;
}

const TABLE_CONFIGS = {
  0: { name: '発注データ', pk: 'ORDER', fields: ['発注ID', '発注番号', '発注先コード', '発注先名', '商品コード', '商品名', '発注数量', '単価', '発注金額', '発注日', '納期予定日', '発注ステータス', '連携システム名', '連携ステータス', '連携日時', 'エラーメッセージ', '備考', '作成日時', '更新日時', '作成者ID', '更新者ID'] },
  1: { name: '単価交渉履歴', pk: 'NEGOTIATION', fields: ['交渉履歴ID', '顧客ID', '商品ID', '交渉日', '交渉種別', '現在単価', '提案単価', '顧客希望単価', '合意単価', '交渉ステータス', '交渉内容', '次回アクション', '営業担当者ID', '承認者ID', '承認日時', '作成日時', '更新日時', '作成者ID'] },
  2: { name: '市場価格データ', pk: 'MARKET_PRICE', fields: ['市場価格ID', '商品コード', '商品名', '市場価格', '価格取得日', '価格情報源', '地域', '備考', '有効フラグ', '作成日時', '更新日時', '作成者'] },
  3: { name: '購買パターン分析結果', pk: 'PURCHASE_PATTERN', fields: ['分析結果ID', '顧客ID', '分析期間開始日', '分析期間終了日', '購買頻度', '平均発注金額', '総購買金額', '主要購買商品カテゴリ', '購買季節性', '価格感度', '交渉頻度', '交渉成功率', '市場価格との乖離率', '顧客ランク', '推奨営業アプローチ', '分析実行日時', '作成日時', '更新日時', '作成者'] },
  4: { name: '価格戦略分析結果', pk: 'PRICE_STRATEGY', fields: ['分析結果ID', '分析対象商品コード', '分析対象顧客ID', '分析期間開始日', '分析期間終了日', '現在単価', '推奨単価', '市場平均単価', '競合最低単価', '価格競争力スコア', '需要予測数量', '売上予測金額', '利益率', '価格弾力性', '戦略区分', 'リスク評価', '実施推奨度', '分析手法', '備考', '承認状況', '承認者ID', '承認日時', '作成者ID', '作成日時', '更新日時'] },
  5: { name: '月次集計データ', pk: 'MONTHLY_SUMMARY', fields: ['集計ID', '集計年月', '商品カテゴリ', '顧客区分', '売上金額', '発注件数', '発注金額', '平均単価', '価格交渉成功率', '市場価格差異率', '新規顧客数', 'リピート顧客数', '集計完了フラグ', '作成日時', '更新日時', '作成者'] },
  6: { name: '顧客別分析データ', pk: 'CUSTOMER_ANALYSIS', fields: ['顧客別分析ID', '顧客ID', '分析期間開始日', '分析期間終了日', '総発注回数', '総発注金額', '平均発注金額', '価格交渉回数', '価格交渉成功率', '市場価格との乖離率', '購買パターン分類', '収益性ランク', '推奨価格戦略', 'リスク評価', '営業優先度', '備考', '作成日時', '更新日時', '作成者'] }
};

async function writeAuditLog(action: string, userId: string, details: any): Promise<void> {
  const auditLog: AuditLog = {
    pk: 'AUDIT',
    sk: `${Date.now()}_${randomUUID()}`,
    action,
    userId,
    timestamp: new Date().toISOString(),
    details
  };
  
  await docClient.send(new PutCommand({
    TableName: TABLE_NAME,
    Item: auditLog
  }));
}

function createResponse(statusCode: number, body: any): APIGatewayProxyResult {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization'
    },
    body: JSON.stringify(body)
  };
}

function getUserRole(event: APIGatewayProxyEvent): Role {
  const role = event.headers['x-user-role'] || event.headers['X-User-Role'] || 'viewer';
  return validateRole(role);
}

function getUserId(event: APIGatewayProxyEvent): string {
  return event.headers['x-user-id'] || event.headers['X-User-Id'] || 'anonymous';
}

function validateTableIndex(tableIndex: string): number {
  const index = parseInt(tableIndex, 10);
  if (isNaN(index) || !TABLE_CONFIGS[index as keyof typeof TABLE_CONFIGS]) {
    throw new Error('Invalid table index');
  }
  return index;
}

function chunkArray<T>(array: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < array.length; i += size) {
    chunks.push(array.slice(i, i + size));
  }
  return chunks;
}

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const method = event.httpMethod;
    const path = event.path;
    const userRole = getUserRole(event);
    const userId = getUserId(event);

    if (method === 'OPTIONS') {
      return createResponse(200, {});
    }

    if (path === '/resources' && method === 'GET') {
      if (!hasPermission(userRole, 'read')) {
        return createResponse(403, { error: 'Insufficient permissions' });
      }

      const resources = Object.entries(TABLE_CONFIGS).map(([index, config]) => ({
        index: parseInt(index),
        name: config.name,
        pk: config.pk,
        fields: config.fields
      }));

      return createResponse(200, { resources });
    }

    const pathParts = path.split('/').filter(p => p);
    
    if (pathParts.length >= 3 && pathParts[0] === 'api' && pathParts[2] === 'bulk' && method === 'POST') {
      if (!hasPermission(userRole, 'write')) {
        return createResponse(403, { error: 'Insufficient permissions' });
      }

      const tableIndex = validateTableIndex(pathParts[1]);
      const config = TABLE_CONFIGS[tableIndex as keyof typeof TABLE_CONFIGS];
      
      const body = JSON.parse(event.body || '{}');
      if (!body.items || !Array.isArray(body.items)) {
        return createResponse(400, { error: 'Invalid request body. Expected { items: [] }' });
      }

      const items = body.items.map((item: any) => ({
        ...item,
        pk: config.pk,
        sk: item.id || randomUUID(),
        id: item.id || randomUUID(),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      }));

      const chunks = chunkArray(items, 25);
      let imported = 0;
      let failed = 0;
      const errors: string[] = [];

      for (const chunk of chunks) {
        try {
          const writeRequests = chunk.map(item => ({
            PutRequest: { Item: item }
          }));

          await docClient.send(new BatchWriteCommand({
            RequestItems: {
              [TABLE_NAME]: writeRequests
            }
          }));
          
          imported += chunk.length;
        } catch (error) {
          failed += chunk.length;
          errors.push(`Batch write failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
      }

      await writeAuditLog('BULK_IMPORT', userId, {
        tableIndex,
        tableName: config.name,
        imported,
        failed,
        totalItems: items.length
      });

      return createResponse(200, { imported, failed, errors });
    }

    if (pathParts.length >= 2 && pathParts[0] === 'api') {
      const tableIndex = validateTableIndex(pathParts[1]);
      const config = TABLE_CONFIGS[tableIndex as keyof typeof TABLE_CONFIGS];
      const itemId = pathParts[2];

      switch (method) {
        case 'GET':
          if (!hasPermission(userRole, 'read')) {
            return createResponse(403, { error: 'Insufficient permissions' });
          }

          if (itemId) {
            const result = await docClient.send(new GetCommand({
              TableName: TABLE_NAME,
              Key: { pk: config.pk, sk: itemId }
            }));

            if (!result.Item) {
              return createResponse(404, { error: 'Item not found' });
            }

            return createResponse(200, result.Item);
          } else {
            const result = await docClient.send(new ScanCommand({
              TableName: TABLE_NAME,
              FilterExpression: 'pk = :pk',
              ExpressionAttributeValues: { ':pk': config.pk }
            }));

            return createResponse(200, { items: result.Items || [] });
          }

        case 'POST':
          if (!hasPermission(userRole, 'write')) {
            return createResponse(403, { error: 'Insufficient permissions' });
          }

          const createBody = JSON.parse(event.body || '{}');
          const newItem = {
            ...createBody,
            pk: config.pk,
            sk: createBody.id || randomUUID(),
            id: createBody.id || randomUUID(),
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
          };

          await docClient.send(new PutCommand({
            TableName: TABLE_NAME,
            Item: newItem
          }));

          await writeAuditLog('CREATE', userId, {
            tableIndex,
            tableName: config.name,
            itemId: newItem.id
          });

          return createResponse(201, newItem);

        case 'PUT':
          if (!hasPermission(userRole, 'write')) {
            return createResponse(403, { error: 'Insufficient permissions' });
          }

          if (!itemId) {
            return createResponse(400, { error: 'Item ID is required for update' });
          }

          const updateBody = JSON.parse(event.body || '{}');
          const updatedItem = {
            ...updateBody,
            pk: config.pk,
            sk: itemId,
            id: itemId,
            updatedAt: new Date().toISOString()
          };

          await docClient.send(new PutCommand({
            TableName: TABLE_NAME,
            Item: updatedItem
          }));

          await writeAuditLog('UPDATE', userId, {
            tableIndex,
            tableName: config.name,
            itemId
          });

          return createResponse(200, updatedItem);

        case 'DELETE':
          if (!hasPermission(userRole, 'delete')) {
            return createResponse(403, { error: 'Insufficient permissions' });
          }

          if (!itemId) {
            return createResponse(400, { error: 'Item ID is required for deletion' });
          }

          await docClient.send(new DeleteCommand({
            TableName: TABLE_NAME,
            Key: { pk: config.pk, sk: itemId }
          }));

          await writeAuditLog('DELETE', userId, {
            tableIndex,
            tableName: config.name,
            itemId
          });

          return createResponse(200, { message: 'Item deleted successfully' });

        default:
          return createResponse(405, { error: 'Method not allowed' });
      }
    }

    return createResponse(404, { error: 'Endpoint not found' });

  } catch (error) {
    console.error('Error:', error);
    
    if (error instanceof Error) {
      if (error.message === 'Invalid role' || error.message === 'Invalid table index') {
        return createResponse(400, { error: error.message });
      }
    }

    return createResponse(500, { error: 'Internal server error' });
  }
};