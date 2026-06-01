import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand, GetCommand, PutCommand, UpdateCommand, DeleteCommand, BatchWriteCommand } from '@aws-sdk/lib-dynamodb';
import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { hasPermission, validateRole, Role } from './rbac';
import { randomUUID } from 'crypto';

const client = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(client);
const TABLE_NAME = process.env.MAIN_TABLE!;

interface RequestContext {
  role: Role;
  userId: string;
}

const TABLE_CONFIGS = {
  '0': { pk: 'ORDER', name: '発注データ' },
  '1': { pk: 'MARKET_PRICE', name: '市場価格データ' },
  '2': { pk: 'MONTHLY_SUMMARY', name: '月次集計データ' },
  '3': { pk: 'PURCHASE_PATTERN', name: '購買パターン分析結果' },
  '4': { pk: 'PRICE_STRATEGY', name: '価格戦略分析結果' },
  '5': { pk: 'CUSTOMER_PRICE_COMPARISON', name: '顧客別単価比較分析結果' },
  '6': { pk: 'ANALYSIS_REPORT', name: '分析レポート' },
  '7': { pk: 'SYSTEM_LOG', name: 'システム操作履歴' }
};

function getRequestContext(event: APIGatewayProxyEvent): RequestContext {
  const role = validateRole(event.headers['x-user-role'] || 'viewer');
  const userId = event.headers['x-user-id'] || 'anonymous';
  return { role, userId };
}

function createResponse(statusCode: number, body: any): APIGatewayProxyResult {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*'
    },
    body: JSON.stringify(body)
  };
}

async function writeAuditLog(action: string, details: any, userId: string): Promise<void> {
  const auditLog = {
    pk: 'AUDIT',
    sk: `${Date.now()}_${randomUUID()}`,
    action,
    details,
    userId,
    timestamp: new Date().toISOString()
  };
  
  await docClient.send(new PutCommand({
    TableName: TABLE_NAME,
    Item: auditLog
  }));
}

function addTimestamps(item: any, isUpdate: boolean = false): any {
  const now = new Date().toISOString();
  if (!isUpdate) {
    item.createdAt = now;
  }
  item.updatedAt = now;
  return item;
}

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const context = getRequestContext(event);
    const method = event.httpMethod;
    const path = event.path;
    const pathSegments = path.split('/').filter(Boolean);

    // GET /resources
    if (method === 'GET' && path === '/resources') {
      if (!hasPermission(context.role, 'read')) {
        return createResponse(403, { error: 'Insufficient permissions' });
      }

      const resources = {
        tables: Object.entries(TABLE_CONFIGS).map(([index, config]) => ({
          index,
          name: config.name,
          pk: config.pk
        })),
        endpoints: {
          list: 'GET /api/{tableIndex}',
          get: 'GET /api/{tableIndex}/{id}',
          create: 'POST /api/{tableIndex}',
          update: 'PUT /api/{tableIndex}/{id}',
          delete: 'DELETE /api/{tableIndex}/{id}',
          bulk: 'POST /api/{tableIndex}/bulk'
        }
      };

      return createResponse(200, resources);
    }

    // API routes
    if (pathSegments[0] === 'api' && pathSegments[1]) {
      const tableIndex = pathSegments[1];
      const tableConfig = TABLE_CONFIGS[tableIndex as keyof typeof TABLE_CONFIGS];
      
      if (!tableConfig) {
        return createResponse(404, { error: 'Table not found' });
      }

      const { pk } = tableConfig;

      // Bulk import: POST /api/{tableIndex}/bulk
      if (method === 'POST' && pathSegments[2] === 'bulk') {
        if (!hasPermission(context.role, 'write')) {
          return createResponse(403, { error: 'Insufficient permissions' });
        }

        const body = JSON.parse(event.body || '{}');
        if (!body.items || !Array.isArray(body.items)) {
          return createResponse(400, { error: 'Invalid request body. Expected { items: [] }' });
        }

        const items = body.items;
        let imported = 0;
        let failed = 0;
        const errors: string[] = [];

        // Process in batches of 25 (DynamoDB BatchWrite limit)
        for (let i = 0; i < items.length; i += 25) {
          const batch = items.slice(i, i + 25);
          const putRequests = batch.map(item => {
            const processedItem = {
              ...item,
              pk,
              sk: item.id || randomUUID(),
              id: item.id || randomUUID(),
              ...addTimestamps(item)
            };
            return {
              PutRequest: {
                Item: processedItem
              }
            };
          });

          try {
            await docClient.send(new BatchWriteCommand({
              RequestItems: {
                [TABLE_NAME]: putRequests
              }
            }));
            imported += batch.length;
          } catch (error) {
            failed += batch.length;
            errors.push(`Batch ${Math.floor(i/25) + 1}: ${error}`);
          }
        }

        await writeAuditLog('BULK_IMPORT', {
          table: tableConfig.name,
          imported,
          failed,
          total: items.length
        }, context.userId);

        return createResponse(200, { imported, failed, errors });
      }

      // List: GET /api/{tableIndex}
      if (method === 'GET' && pathSegments.length === 2) {
        if (!hasPermission(context.role, 'read')) {
          return createResponse(403, { error: 'Insufficient permissions' });
        }

        const result = await docClient.send(new ScanCommand({
          TableName: TABLE_NAME,
          FilterExpression: 'pk = :pk',
          ExpressionAttributeValues: {
            ':pk': pk
          }
        }));

        return createResponse(200, { items: result.Items || [] });
      }

      // Get by ID: GET /api/{tableIndex}/{id}
      if (method === 'GET' && pathSegments.length === 3) {
        if (!hasPermission(context.role, 'read')) {
          return createResponse(403, { error: 'Insufficient permissions' });
        }

        const id = pathSegments[2];
        const result = await docClient.send(new GetCommand({
          TableName: TABLE_NAME,
          Key: { pk, sk: id }
        }));

        if (!result.Item) {
          return createResponse(404, { error: 'Item not found' });
        }

        return createResponse(200, result.Item);
      }

      // Create: POST /api/{tableIndex}
      if (method === 'POST' && pathSegments.length === 2) {
        if (!hasPermission(context.role, 'write')) {
          return createResponse(403, { error: 'Insufficient permissions' });
        }

        const body = JSON.parse(event.body || '{}');
        const id = body.id || randomUUID();
        const item = {
          ...body,
          pk,
          sk: id,
          id,
          ...addTimestamps(body)
        };

        await docClient.send(new PutCommand({
          TableName: TABLE_NAME,
          Item: item
        }));

        await writeAuditLog('CREATE', {
          table: tableConfig.name,
          itemId: id
        }, context.userId);

        return createResponse(201, item);
      }

      // Update: PUT /api/{tableIndex}/{id}
      if (method === 'PUT' && pathSegments.length === 3) {
        if (!hasPermission(context.role, 'write')) {
          return createResponse(403, { error: 'Insufficient permissions' });
        }

        const id = pathSegments[2];
        const body = JSON.parse(event.body || '{}');
        
        // Check if item exists
        const existing = await docClient.send(new GetCommand({
          TableName: TABLE_NAME,
          Key: { pk, sk: id }
        }));

        if (!existing.Item) {
          return createResponse(404, { error: 'Item not found' });
        }

        const updatedItem = {
          ...existing.Item,
          ...body,
          pk,
          sk: id,
          id,
          ...addTimestamps(body, true)
        };

        await docClient.send(new PutCommand({
          TableName: TABLE_NAME,
          Item: updatedItem
        }));

        await writeAuditLog('UPDATE', {
          table: tableConfig.name,
          itemId: id
        }, context.userId);

        return createResponse(200, updatedItem);
      }

      // Delete: DELETE /api/{tableIndex}/{id}
      if (method === 'DELETE' && pathSegments.length === 3) {
        if (!hasPermission(context.role, 'delete')) {
          return createResponse(403, { error: 'Insufficient permissions' });
        }

        const id = pathSegments[2];
        
        // Check if item exists
        const existing = await docClient.send(new GetCommand({
          TableName: TABLE_NAME,
          Key: { pk, sk: id }
        }));

        if (!existing.Item) {
          return createResponse(404, { error: 'Item not found' });
        }

        await docClient.send(new DeleteCommand({
          TableName: TABLE_NAME,
          Key: { pk, sk: id }
        }));

        await writeAuditLog('DELETE', {
          table: tableConfig.name,
          itemId: id
        }, context.userId);

        return createResponse(200, { message: 'Item deleted successfully' });
      }
    }

    return createResponse(404, { error: 'Endpoint not found' });

  } catch (error) {
    console.error('Error:', error);
    
    if (error instanceof SyntaxError) {
      return createResponse(400, { error: 'Invalid JSON in request body' });
    }
    
    if (error instanceof Error && error.message === 'Invalid role') {
      return createResponse(403, { error: 'Invalid role specified' });
    }

    return createResponse(500, { error: 'Internal server error' });
  }
};