import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand, GetCommand, PutCommand, DeleteCommand, BatchWriteCommand } from '@aws-sdk/lib-dynamodb';
import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { hasPermission, validateRole, Role } from './rbac';
import { randomUUID } from 'crypto';

const client = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(client);
const TABLE_NAME = process.env.MAIN_TABLE!;

interface OrderData {
  id: string;
  orderNumber: string;
  orderDate: string;
  deliveryDate: string;
  supplierCode: string;
  supplierName: string;
  orderAmount: number;
  taxAmount: number;
  orderStatus: string;
  integrationStatus: string;
  integrationDate?: string;
  remarks?: string;
  createdBy: string;
  createdAt: string;
  updatedBy?: string;
  updatedAt: string;
}

interface PriceNegotiationHistory {
  id: string;
  customerId: string;
  productId: string;
  salesRepId: string;
  negotiationStartDate: string;
  currentPrice: number;
  desiredPrice: number;
  proposedPrice?: number;
  negotiationStatus: string;
  negotiationContent?: string;
  agreedPrice?: number;
  agreementDate?: string;
  effectiveStartDate?: string;
  effectiveEndDate?: string;
  approverId?: string;
  approvalDate?: string;
  remarks?: string;
  createdAt: string;
  updatedAt: string;
  createdBy: string;
}

interface MarketPriceData {
  id: string;
  productCode: string;
  productName: string;
  marketPrice: number;
  priceAcquisitionDate: string;
  priceSource: string;
  region?: string;
  remarks?: string;
  validFlag: boolean;
  createdAt: string;
  updatedAt: string;
  createdBy: string;
}

interface PurchasePatternAnalysis {
  id: string;
  customerId: string;
  analysisStartDate: string;
  analysisEndDate: string;
  purchaseFrequency: number;
  averageOrderAmount: number;
  totalPurchaseAmount: number;
  mainProductCategory: string;
  purchaseSeasonality?: string;
  priceSensitivity: string;
  negotiationFrequency: number;
  negotiationSuccessRate: number;
  recommendedApproach?: string;
  riskAssessment: string;
  analysisExecutionDate: string;
  createdAt: string;
  updatedAt: string;
  createdBy: string;
}

interface PriceStrategyAnalysis {
  id: string;
  targetProductCode: string;
  targetCustomerId?: string;
  analysisStartDate: string;
  analysisEndDate: string;
  currentSalesPrice: number;
  recommendedSalesPrice: number;
  marketAveragePrice: number;
  competitorLowestPrice?: number;
  priceElasticity?: string;
  profitMargin: string;
  negotiationMargin?: number;
  strategyClassification: string;
  riskAssessment: string;
  implementationRecommendation: string;
  analysisComment?: string;
  approvalStatus: string;
  approverId?: string;
  approvalDate?: string;
  validUntil: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

type ResourceType = 'orders' | 'price-negotiations' | 'market-prices' | 'purchase-patterns' | 'price-strategies';

const RESOURCE_TYPES: Record<string, ResourceType> = {
  '0': 'orders',
  '1': 'price-negotiations',
  '2': 'market-prices',
  '3': 'purchase-patterns',
  '4': 'price-strategies'
};

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

function getUserRole(event: APIGatewayProxyEvent): Role {
  const role = event.headers['x-user-role'] || event.headers['X-User-Role'];
  if (!role) {
    throw new Error('Missing user role');
  }
  return validateRole(role);
}

function getUserId(event: APIGatewayProxyEvent): string {
  const userId = event.headers['x-user-id'] || event.headers['X-User-Id'];
  if (!userId) {
    throw new Error('Missing user ID');
  }
  return userId;
}

async function createAuditLog(action: string, resourceType: string, resourceId: string, userId: string, details?: any) {
  const auditLog = {
    pk: 'AUDIT',
    sk: `${Date.now()}_${randomUUID()}`,
    action,
    resourceType,
    resourceId,
    userId,
    timestamp: new Date().toISOString(),
    details
  };

  await docClient.send(new PutCommand({
    TableName: TABLE_NAME,
    Item: auditLog
  }));
}

function validateOrderData(data: any): Partial<OrderData> {
  const errors: string[] = [];
  
  if (!data.orderNumber) errors.push('orderNumber is required');
  if (!data.orderDate) errors.push('orderDate is required');
  if (!data.deliveryDate) errors.push('deliveryDate is required');
  if (!data.supplierCode) errors.push('supplierCode is required');
  if (!data.supplierName) errors.push('supplierName is required');
  if (typeof data.orderAmount !== 'number') errors.push('orderAmount must be a number');
  if (typeof data.taxAmount !== 'number') errors.push('taxAmount must be a number');
  if (!data.orderStatus) errors.push('orderStatus is required');
  if (!data.integrationStatus) errors.push('integrationStatus is required');
  if (!data.createdBy) errors.push('createdBy is required');
  
  if (errors.length > 0) {
    throw new Error(`Validation failed: ${errors.join(', ')}`);
  }
  
  return data;
}

function validatePriceNegotiationData(data: any): Partial<PriceNegotiationHistory> {
  const errors: string[] = [];
  
  if (!data.customerId) errors.push('customerId is required');
  if (!data.productId) errors.push('productId is required');
  if (!data.salesRepId) errors.push('salesRepId is required');
  if (!data.negotiationStartDate) errors.push('negotiationStartDate is required');
  if (typeof data.currentPrice !== 'number') errors.push('currentPrice must be a number');
  if (typeof data.desiredPrice !== 'number') errors.push('desiredPrice must be a number');
  if (!data.negotiationStatus) errors.push('negotiationStatus is required');
  if (!data.createdBy) errors.push('createdBy is required');
  
  if (errors.length > 0) {
    throw new Error(`Validation failed: ${errors.join(', ')}`);
  }
  
  return data;
}

function validateMarketPriceData(data: any): Partial<MarketPriceData> {
  const errors: string[] = [];
  
  if (!data.productCode) errors.push('productCode is required');
  if (!data.productName) errors.push('productName is required');
  if (typeof data.marketPrice !== 'number') errors.push('marketPrice must be a number');
  if (!data.priceAcquisitionDate) errors.push('priceAcquisitionDate is required');
  if (!data.priceSource) errors.push('priceSource is required');
  if (typeof data.validFlag !== 'boolean') errors.push('validFlag must be a boolean');
  if (!data.createdBy) errors.push('createdBy is required');
  
  if (errors.length > 0) {
    throw new Error(`Validation failed: ${errors.join(', ')}`);
  }
  
  return data;
}

function validatePurchasePatternData(data: any): Partial<PurchasePatternAnalysis> {
  const errors: string[] = [];
  
  if (!data.customerId) errors.push('customerId is required');
  if (!data.analysisStartDate) errors.push('analysisStartDate is required');
  if (!data.analysisEndDate) errors.push('analysisEndDate is required');
  if (typeof data.purchaseFrequency !== 'number') errors.push('purchaseFrequency must be a number');
  if (typeof data.averageOrderAmount !== 'number') errors.push('averageOrderAmount must be a number');
  if (typeof data.totalPurchaseAmount !== 'number') errors.push('totalPurchaseAmount must be a number');
  if (!data.mainProductCategory) errors.push('mainProductCategory is required');
  if (!data.priceSensitivity) errors.push('priceSensitivity is required');
  if (typeof data.negotiationFrequency !== 'number') errors.push('negotiationFrequency must be a number');
  if (typeof data.negotiationSuccessRate !== 'number') errors.push('negotiationSuccessRate must be a number');
  if (!data.riskAssessment) errors.push('riskAssessment is required');
  if (!data.analysisExecutionDate) errors.push('analysisExecutionDate is required');
  if (!data.createdBy) errors.push('createdBy is required');
  
  if (errors.length > 0) {
    throw new Error(`Validation failed: ${errors.join(', ')}`);
  }
  
  return data;
}

function validatePriceStrategyData(data: any): Partial<PriceStrategyAnalysis> {
  const errors: string[] = [];
  
  if (!data.targetProductCode) errors.push('targetProductCode is required');
  if (!data.analysisStartDate) errors.push('analysisStartDate is required');
  if (!data.analysisEndDate) errors.push('analysisEndDate is required');
  if (typeof data.currentSalesPrice !== 'number') errors.push('currentSalesPrice must be a number');
  if (typeof data.recommendedSalesPrice !== 'number') errors.push('recommendedSalesPrice must be a number');
  if (typeof data.marketAveragePrice !== 'number') errors.push('marketAveragePrice must be a number');
  if (!data.profitMargin) errors.push('profitMargin is required');
  if (!data.strategyClassification) errors.push('strategyClassification is required');
  if (!data.riskAssessment) errors.push('riskAssessment is required');
  if (!data.implementationRecommendation) errors.push('implementationRecommendation is required');
  if (!data.approvalStatus) errors.push('approvalStatus is required');
  if (!data.validUntil) errors.push('validUntil is required');
  if (!data.createdBy) errors.push('createdBy is required');
  
  if (errors.length > 0) {
    throw new Error(`Validation failed: ${errors.join(', ')}`);
  }
  
  return data;
}

function getResourcePrefix(resourceType: ResourceType): string {
  const prefixes = {
    'orders': 'ORDER',
    'price-negotiations': 'PRICE_NEG',
    'market-prices': 'MARKET_PRICE',
    'purchase-patterns': 'PURCHASE_PATTERN',
    'price-strategies': 'PRICE_STRATEGY'
  };
  return prefixes[resourceType];
}

async function handleGetResources(resourceType: ResourceType, role: Role): Promise<APIGatewayProxyResult> {
  if (!hasPermission(role, 'read')) {
    return createResponse(403, { error: 'Insufficient permissions' });
  }

  try {
    const prefix = getResourcePrefix(resourceType);
    const result = await docClient.send(new ScanCommand({
      TableName: TABLE_NAME,
      FilterExpression: 'begins_with(pk, :prefix)',
      ExpressionAttributeValues: {
        ':prefix': prefix
      }
    }));

    return createResponse(200, {
      items: result.Items || [],
      count: result.Count || 0
    });
  } catch (error) {
    console.error('Error getting resources:', error);
    return createResponse(500, { error: 'Internal server error' });
  }
}

async function handleGetResource(resourceType: ResourceType, id: string, role: Role): Promise<APIGatewayProxyResult> {
  if (!hasPermission(role, 'read')) {
    return createResponse(403, { error: 'Insufficient permissions' });
  }

  try {
    const prefix = getResourcePrefix(resourceType);
    const result = await docClient.send(new GetCommand({
      TableName: TABLE_NAME,
      Key: {
        pk: prefix,
        sk: id
      }
    }));

    if (!result.Item) {
      return createResponse(404, { error: 'Resource not found' });
    }

    return createResponse(200, result.Item);
  } catch (error) {
    console.error('Error getting resource:', error);
    return createResponse(500, { error: 'Internal server error' });
  }
}

async function handleCreateResource(resourceType: ResourceType, data: any, role: Role, userId: string): Promise<APIGatewayProxyResult> {
  if (!hasPermission(role, 'write')) {
    return createResponse(403, { error: 'Insufficient permissions' });
  }

  try {
    let validatedData;
    switch (resourceType) {
      case 'orders':
        validatedData = validateOrderData(data);
        break;
      case 'price-negotiations':
        validatedData = validatePriceNegotiationData(data);
        break;
      case 'market-prices':
        validatedData = validateMarketPriceData(data);
        break;
      case 'purchase-patterns':
        validatedData = validatePurchasePatternData(data);
        break;
      case 'price-strategies':
        validatedData = validatePriceStrategyData(data);
        break;
      default:
        return createResponse(400, { error: 'Invalid resource type' });
    }

    const id = randomUUID();
    const now = new Date().toISOString();
    const prefix = getResourcePrefix(resourceType);

    const item = {
      pk: prefix,
      sk: id,
      id,
      ...validatedData,
      createdAt: now,
      updatedAt: now,
      createdBy: userId
    };

    await docClient.send(new PutCommand({
      TableName: TABLE_NAME,
      Item: item
    }));

    await createAuditLog('CREATE', resourceType, id, userId, { item });

    return createResponse(201, item);
  } catch (error) {
    console.error('Error creating resource:', error);
    if (error instanceof Error && error.message.includes('Validation failed')) {
      return createResponse(400, { error: error.message });
    }
    return createResponse(500, { error: 'Internal server error' });
  }
}

async function handleUpdateResource(resourceType: ResourceType, id: string, data: any, role: Role, userId: string): Promise<APIGatewayProxyResult> {
  if (!hasPermission(role, 'write')) {
    return createResponse(403, { error: 'Insufficient permissions' });
  }

  try {
    const prefix = getResourcePrefix(resourceType);
    const existing = await docClient.send(new GetCommand({
      TableName: TABLE_NAME,
      Key: {
        pk: prefix,
        sk: id
      }
    }));

    if (!existing.Item) {
      return createResponse(404, { error: 'Resource not found' });
    }

    let validatedData;
    switch (resourceType) {
      case 'orders':
        validatedData = validateOrderData({ ...existing.Item, ...data });
        break;
      case 'price-negotiations':
        validatedData = validatePriceNegotiationData({ ...existing.Item, ...data });
        break;
      case 'market-prices':
        validatedData = validateMarketPriceData({ ...existing.Item, ...data });
        break;
      case 'purchase-patterns':
        validatedData = validatePurchasePatternData({ ...existing.Item, ...data });
        break;
      case 'price-strategies':
        validatedData = validatePriceStrategyData({ ...existing.Item, ...data });
        break;
      default:
        return createResponse(400, { error: 'Invalid resource type' });
    }

    const updatedItem = {
      ...existing.Item,
      ...validatedData,
      updatedAt: new Date().toISOString(),
      updatedBy: userId
    };

    await docClient.send(new PutCommand({
      TableName: TABLE_NAME,
      Item: updatedItem
    }));

    await createAuditLog('UPDATE', resourceType, id, userId, { before: existing.Item, after: updatedItem });

    return createResponse(200, updatedItem);
  } catch (error) {
    console.error('Error updating resource:', error);
    if (error instanceof Error && error.message.includes('Validation failed')) {
      return createResponse(400, { error: error.message });
    }
    return createResponse(500, { error: 'Internal server error' });
  }
}

async function handleDeleteResource(resourceType: ResourceType, id: string, role: Role, userId: string): Promise<APIGatewayProxyResult> {
  if (!hasPermission(role, 'delete')) {
    return createResponse(403, { error: 'Insufficient permissions' });
  }

  try {
    const prefix = getResourcePrefix(resourceType);
    const existing = await docClient.send(new GetCommand({
      TableName: TABLE_NAME,
      Key: {
        pk: prefix,
        sk: id
      }
    }));

    if (!existing.Item) {
      return createResponse(404, { error: 'Resource not found' });
    }

    await docClient.send(new DeleteCommand({
      TableName: TABLE_NAME,
      Key: {
        pk: prefix,
        sk: id
      }
    }));

    await createAuditLog('DELETE', resourceType, id, userId, { deletedItem: existing.Item });

    return createResponse(200, { message: 'Resource deleted successfully' });
  } catch (error) {
    console.error('Error deleting resource:', error);
    return createResponse(500, { error: 'Internal server error' });
  }
}

async function handleBulkImport(resourceType: ResourceType, items: any[], role: Role, userId: string): Promise<APIGatewayProxyResult> {
  if (!hasPermission(role, 'write')) {
    return createResponse(403, { error: 'Insufficient permissions' });
  }

  try {
    const prefix = getResourcePrefix(resourceType);
    const now = new Date().toISOString();
    let imported = 0;
    let failed = 0;
    const errors: string[] = [];

    // Process items in batches of 25 (DynamoDB BatchWrite limit)
    for (let i = 0; i < items.length; i += 25) {
      const batch = items.slice(i, i + 25);
      const writeRequests = [];

      for (const item of batch) {
        try {
          let validatedData;
          switch (resourceType) {
            case 'orders':
              validatedData = validateOrderData(item);
              break;
            case 'price-negotiations':
              validatedData = validatePriceNegotiationData(item);
              break;
            case 'market-prices':
              validatedData = validateMarketPriceData(item);
              break;
            case 'purchase-patterns':
              validatedData = validatePurchasePatternData(item);
              break;
            case 'price-strategies':
              validatedData = validatePriceStrategyData(item);
              break;
            default:
              throw new Error('Invalid resource type');
          }

          const id = item.id || randomUUID();
          const processedItem = {
            pk: prefix,
            sk: id,
            id,
            ...validatedData,
            createdAt: item.createdAt || now,
            updatedAt: now,
            createdBy: item.createdBy || userId
          };

          writeRequests.push({
            PutRequest: {
              Item: processedItem
            }
          });
        } catch (error) {
          failed++;
          errors.push(`Item ${i + batch.indexOf(item)}: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
      }

      if (writeRequests.length > 0) {
        try {
          await docClient.send(new BatchWriteCommand({
            RequestItems: {
              [TABLE_NAME]: writeRequests
            }
          }));
          imported += writeRequests.length;
        } catch (error) {
          failed += writeRequests.length;
          errors.push(`Batch write failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
      }
    }

    await createAuditLog('BULK_IMPORT', resourceType, 'bulk', userId, { imported, failed, totalItems: items.length });

    return createResponse(200, {
      imported,
      failed,
      errors
    });
  } catch (error) {
    console.error('Error in bulk import:', error);
    return createResponse(500, { error: 'Internal server error' });
  }
}

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const role = getUserRole(event);
    const userId = getUserId(event);
    const method = event.httpMethod;
    const path = event.path;
    const pathParts = path.split('/').filter(p => p);

    // Handle /resources endpoint
    if (pathParts.length === 1 && pathParts[0] === 'resources') {
      if (method === 'GET') {
        // Return all resource types
        const allResources = await Promise.all(
          Object.values(RESOURCE_TYPES).map(async (resourceType) => {
            try {
              const result = await handleGetResources(resourceType, role);
              const data = JSON.parse(result.body);
              return {
                type: resourceType,
                items: data.items || [],
                count: data.count || 0
              };
            } catch (error) {
              return {
                type: resourceType,
                items: [],
                count: 0,
                error: error instanceof Error ? error.message : 'Unknown error'
              };
            }
          })
        );
        return createResponse(200, { resources: allResources });
      }
    }

    // Handle /api/{tableIndex}/bulk endpoints
    if (pathParts.length === 3 && pathParts[0] === 'api' && pathParts[2] === 'bulk') {
      const tableIndex = pathParts[1];
      const resourceType = RESOURCE_TYPES[tableIndex];
      
      if (!resourceType) {
        return createResponse(400, { error: 'Invalid table index' });
      }

      if (method === 'POST') {
        if (!event.body) {
          return createResponse(400, { error: 'Request body is required' });
        }

        const { items } = JSON.parse(event.body);
        if (!Array.isArray(items)) {
          return createResponse(400, { error: 'Items must be an array' });
        }

        return await handleBulkImport(resourceType, items, role, userId);
      }
    }

    // Handle /api/{tableIndex} endpoints
    if (pathParts.length >= 2 && pathParts[0] === 'api') {
      const tableIndex = pathParts[1];
      const resourceType = RESOURCE_TYPES[tableIndex];
      
      if (!resourceType) {
        return createResponse(400, { error: 'Invalid table index' });
      }

      if (pathParts.length === 2) {
        // /api/{tableIndex}
        if (method === 'GET') {
          return await handleGetResources(resourceType, role);
        } else if (method === 'POST') {
          if (!event.body) {
            return createResponse(400, { error: 'Request body is required' });
          }
          const data = JSON.parse(event.body);
          return await handleCreateResource(resourceType, data, role, userId);
        }
      } else if (pathParts.length === 3) {
        // /api/{tableIndex}/{id}
        const id = pathParts[2];
        if (method === 'GET') {
          return await handleGetResource(resourceType, id, role);
        } else if (method === 'PUT') {
          if (!event.body) {
            return createResponse(400, { error: 'Request body is required' });
          }
          const data = JSON.parse(event.body);
          return await handleUpdateResource(resourceType, id, data, role, userId);
        } else if (method === 'DELETE') {
          return await handleDeleteResource(resourceType, id, role, userId);
        }
      }
    }

    return createResponse(404, { error: 'Endpoint not found' });
  } catch (error) {
    console.error('Handler error:', error);
    if (error instanceof Error && (error.message.includes('Missing user') || error.message.includes('Invalid role'))) {
      return createResponse(401, { error: 'Unauthorized' });
    }
    return createResponse(500, { error: 'Internal server error' });
  }
};