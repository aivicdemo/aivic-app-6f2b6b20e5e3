import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand, GetCommand, PutCommand, UpdateCommand, DeleteCommand, BatchWriteCommand } from '@aws-sdk/lib-dynamodb';
import { hasPermission, extractUserRole, Role } from './rbac';
import { randomUUID } from 'crypto';

const client = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(client);
const TABLE_NAME = process.env.MAIN_TABLE!;

interface APIGatewayEvent {
  httpMethod: string;
  path: string;
  pathParameters?: { [key: string]: string };
  queryStringParameters?: { [key: string]: string };
  body?: string;
  headers?: { [key: string]: string };
}

interface APIResponse {
  statusCode: number;
  headers: { [key: string]: string };
  body: string;
}

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization',
  'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS'
};

const TABLE_CONFIGS = {
  '0': { name: 'orders', pk: 'ORDER#', resource: 'orders' },
  '1': { name: 'market-prices', pk: 'MARKET_PRICE#', resource: 'market-prices' },
  '2': { name: 'monthly-summaries', pk: 'MONTHLY_SUMMARY#', resource: 'monthly-summaries' },
  '3': { name: 'purchase-patterns', pk: 'PURCHASE_PATTERN#', resource: 'purchase-patterns' },
  '4': { name: 'price-strategies', pk: 'PRICE_STRATEGY#', resource: 'price-strategies' },
  '5': { name: 'customer-price-comparisons', pk: 'CUSTOMER_PRICE#', resource: 'customer-price-comparisons' },
  '6': { name: 'analysis-reports', pk: 'REPORT#', resource: 'analysis-reports' },
  '7': { name: 'system-logs', pk: 'SYSTEM_LOG#', resource: 'system-logs' }
};

async function createAuditLog(action: string, resource: string, userId: string, details?: any) {
  const auditLog = {
    pk: 'AUDIT',
    sk: `${Date.now()}#${randomUUID()}`,
    action,
    resource,
    userId,
    details: details ? JSON.stringify(details) : undefined,
    timestamp: new Date().toISOString()
  };
  
  await docClient.send(new PutCommand({
    TableName: TABLE_NAME,
    Item: auditLog
  }));
}

function validateRequired(data: any, requiredFields: string[]): string[] {
  const errors: string[] = [];
  for (const field of requiredFields) {
    if (!data[field]) {
      errors.push(`${field} is required`);
    }
  }
  return errors;
}

function createResponse(statusCode: number, body: any): APIResponse {
  return {
    statusCode,
    headers: CORS_HEADERS,
    body: JSON.stringify(body)
  };
}

export const handler = async (event: APIGatewayEvent): Promise<APIResponse> => {
  try {
    if (event.httpMethod === 'OPTIONS') {
      return createResponse(200, {});
    }

    const userRole = extractUserRole(event);
    const path = event.path;
    const method = event.httpMethod;
    
    // Handle /resources endpoint
    if (path === '/resources' && method === 'GET') {
      if (!hasPermission(userRole, 'orders', 'read')) {
        return createResponse(403, { error: 'Insufficient permissions' });
      }
      
      const resources = {
        tables: Object.entries(TABLE_CONFIGS).map(([index, config]) => ({
          index,
          name: config.name,
          resource: config.resource
        })),
        userRole,
        permissions: {
          canRead: hasPermission(userRole, 'orders', 'read'),
          canWrite: hasPermission(userRole, 'orders', 'create'),
          canUpdate: hasPermission(userRole, 'orders', 'update'),
          canDelete: hasPermission(userRole, 'orders', 'delete')
        }
      };
      
      return createResponse(200, resources);
    }

    // Parse table-specific endpoints
    const tableMatch = path.match(/^\/api\/(\d+)(?:\/(\w+))?(?:\/(\w+))?$/);
    if (!tableMatch) {
      return createResponse(404, { error: 'Endpoint not found' });
    }

    const [, tableIndex, action, itemId] = tableMatch;
    const tableConfig = TABLE_CONFIGS[tableIndex as keyof typeof TABLE_CONFIGS];
    
    if (!tableConfig) {
      return createResponse(404, { error: 'Table not found' });
    }

    const { pk, resource } = tableConfig;

    // Handle bulk import
    if (action === 'bulk' && method === 'POST') {
      if (!hasPermission(userRole, 'bulk', 'create')) {
        return createResponse(403, { error: 'Insufficient permissions for bulk operations' });
      }

      const body = JSON.parse(event.body || '{}');
      if (!body.items || !Array.isArray(body.items)) {
        return createResponse(400, { error: 'Invalid request body. Expected { items: [] }' });
      }

      let imported = 0;
      let failed = 0;
      const errors: string[] = [];
      const now = new Date().toISOString();
      const userId = `user_${userRole}`;

      // Process in batches of 25 (DynamoDB BatchWrite limit)
      for (let i = 0; i < body.items.length; i += 25) {
        const batch = body.items.slice(i, i + 25);
        const writeRequests = batch.map((item: any) => {
          const id = item.id || randomUUID();
          return {
            PutRequest: {
              Item: {
                pk: `${pk}${id}`,
                sk: id,
                ...item,
                id,
                createdAt: now,
                updatedAt: now,
                createdBy: userId,
                updatedBy: userId
              }
            }
          };
        });

        try {
          await docClient.send(new BatchWriteCommand({
            RequestItems: {
              [TABLE_NAME]: writeRequests
            }
          }));
          imported += batch.length;
        } catch (error) {
          failed += batch.length;
          errors.push(`Batch ${Math.floor(i/25) + 1}: ${error}`);
        }
      }

      await createAuditLog('BULK_IMPORT', resource, userId, { imported, failed, total: body.items.length });
      
      return createResponse(200, { imported, failed, errors });
    }

    // Handle CRUD operations
    switch (method) {
      case 'GET':
        if (!hasPermission(userRole, resource, 'read')) {
          return createResponse(403, { error: 'Insufficient permissions' });
        }

        if (itemId) {
          // Get single item
          const result = await docClient.send(new GetCommand({
            TableName: TABLE_NAME,
            Key: { pk: `${pk}${itemId}`, sk: itemId }
          }));
          
          if (!result.Item) {
            return createResponse(404, { error: 'Item not found' });
          }
          
          return createResponse(200, result.Item);
        } else {
          // List items
          const result = await docClient.send(new ScanCommand({
            TableName: TABLE_NAME,
            FilterExpression: 'begins_with(pk, :pk)',
            ExpressionAttributeValues: { ':pk': pk }
          }));
          
          return createResponse(200, { items: result.Items || [] });
        }

      case 'POST':
        if (!hasPermission(userRole, resource, 'create')) {
          return createResponse(403, { error: 'Insufficient permissions' });
        }

        const createBody = JSON.parse(event.body || '{}');
        const createId = createBody.id || randomUUID();
        const now = new Date().toISOString();
        const userId = `user_${userRole}`;
        
        const newItem = {
          pk: `${pk}${createId}`,
          sk: createId,
          ...createBody,
          id: createId,
          createdAt: now,
          updatedAt: now,
          createdBy: userId,
          updatedBy: userId
        };

        await docClient.send(new PutCommand({
          TableName: TABLE_NAME,
          Item: newItem
        }));

        await createAuditLog('CREATE', resource, userId, { id: createId });
        
        return createResponse(201, newItem);

      case 'PUT':
        if (!itemId) {
          return createResponse(400, { error: 'Item ID required for update' });
        }
        
        if (!hasPermission(userRole, resource, 'update')) {
          return createResponse(403, { error: 'Insufficient permissions' });
        }

        const updateBody = JSON.parse(event.body || '{}');
        const updateUserId = `user_${userRole}`;
        
        const updatedItem = {
          pk: `${pk}${itemId}`,
          sk: itemId,
          ...updateBody,
          id: itemId,
          updatedAt: new Date().toISOString(),
          updatedBy: updateUserId
        };

        await docClient.send(new PutCommand({
          TableName: TABLE_NAME,
          Item: updatedItem
        }));

        await createAuditLog('UPDATE', resource, updateUserId, { id: itemId });
        
        return createResponse(200, updatedItem);

      case 'DELETE':
        if (!itemId) {
          return createResponse(400, { error: 'Item ID required for deletion' });
        }
        
        if (!hasPermission(userRole, resource, 'delete')) {
          return createResponse(403, { error: 'Insufficient permissions' });
        }

        await docClient.send(new DeleteCommand({
          TableName: TABLE_NAME,
          Key: { pk: `${pk}${itemId}`, sk: itemId }
        }));

        await createAuditLog('DELETE', resource, `user_${userRole}`, { id: itemId });
        
        return createResponse(200, { message: 'Item deleted successfully' });

      default:
        return createResponse(405, { error: 'Method not allowed' });
    }
  } catch (error) {
    console.error('Error:', error);
    return createResponse(500, { error: 'Internal server error' });
  }
};