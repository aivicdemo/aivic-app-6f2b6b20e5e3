import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand, GetCommand, PutCommand, DeleteCommand, BatchWriteCommand } from '@aws-sdk/lib-dynamodb';
import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { hasPermission, validateRole, Role } from './rbac';
import { randomUUID } from 'crypto';

const client = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(client);
const TABLE_NAME = process.env.MAIN_TABLE!;

interface OrderData {
  orderId: string;
  orderNumber: string;
  supplierCode: string;
  supplierName: string;
  productCode: string;
  productName: string;
  quantity: number;
  unitPrice: number;
  totalAmount: number;
  orderDate: string;
  deliveryDate: string;
  orderStatus: string;
  integrationStatus: string;
  integrationErrorMessage?: string;
  remarks?: string;
  createdAt: string;
  updatedAt: string;
  createdBy: string;
  updatedBy: string;
}

interface PriceNegotiationHistory {
  negotiationId: string;
  customerId: string;
  productId: string;
  negotiationStartDate: string;
  negotiationEndDate?: string;
  currentPrice: number;
  proposedPrice: number;
  customerDesiredPrice?: number;
  agreedPrice?: number;
  negotiationStatus: string;
  negotiationReason: string;
  negotiationContent?: string;
  approverId?: string;
  approvalDate?: string;
  effectiveStartDate?: string;
  salesRepId: string;
  createdAt: string;
  updatedAt: string;
  createdBy: string;
}

interface MarketPriceData {
  marketPriceId: string;
  productCode: string;
  productName: string;
  marketPrice: number;
  priceDate: string;
  priceSource: string;
  region?: string;
  remarks?: string;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
  createdBy: string;
}

interface MonthlyAggregationResult {
  aggregationId: string;
  targetMonth: string;
  salesRepId?: string;
  customerId?: string;
  productCategory?: string;
  orderCount: number;
  totalOrderAmount: number;
  averageUnitPrice: number;
  priceNegotiationCount: number;
  successfulNegotiationCount: number;
  costReduction: number;
  marketPriceDeviationRate: number;
  monthlyGrowthRate: number;
  aggregationStatus: string;
  createdAt: string;
  updatedAt: string;
  createdBy: string;
}

interface PurchasePatternAnalysisResult {
  analysisResultId: string;
  analysisStartDate: string;
  analysisEndDate: string;
  customerId?: string;
  productCategory?: string;
  purchaseFrequency: number;
  averageOrderQuantity: number;
  averageUnitPrice: number;
  marketPriceDeviationRate: number;
  seasonalPattern?: string;
  priceSensitivity: string;
  recommendedAction?: string;
  analysisExecutionDate: string;
  analysisUserId: string;
  createdAt: string;
  updatedAt: string;
}

interface PriceStrategyAnalysisResult {
  analysisResultId: string;
  targetProductCode: string;
  targetProductName: string;
  analysisStartDate: string;
  analysisEndDate: string;
  currentUnitPrice: number;
  recommendedUnitPrice: number;
  marketAverageUnitPrice: number;
  priceCompetitivenessIndex: number;
  salesForecast: number;
  profitMargin: number;
  analysisMethod: string;
  strategyCategory: string;
  riskAssessment: string;
  implementationRecommendation: string;
  analysisComment?: string;
  approvalStatus: string;
  approverId?: string;
  approvalDate?: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

interface CustomerPriceComparisonAnalysisResult {
  analysisResultId: string;
  customerId: string;
  productId: string;
  analysisStartDate: string;
  analysisEndDate: string;
  customerUnitPrice: number;
  marketAverageUnitPrice: number;
  allCustomerAverageUnitPrice: number;
  marketComparisonDifference: number;
  marketComparisonRate: number;
  allCustomerComparisonDifference: number;
  allCustomerComparisonRate: number;
  priceRank: string;
  transactionQuantity: number;
  transactionCount: number;
  priceImprovementPotential?: number;
  recommendedAction?: string;
  remarks?: string;
  createdAt: string;
  updatedAt: string;
  createdBy: string;
}

type ResourceType = OrderData | PriceNegotiationHistory | MarketPriceData | MonthlyAggregationResult | PurchasePatternAnalysisResult | PriceStrategyAnalysisResult | CustomerPriceComparisonAnalysisResult;

const RESOURCE_TYPES = [
  'orders',
  'price-negotiations',
  'market-prices',
  'monthly-aggregations',
  'purchase-patterns',
  'price-strategies',
  'customer-price-comparisons'
];

function createAuditLog(action: string, resourceType: string, resourceId: string, userId: string, details?: any) {
  return {
    pk: 'AUDIT',
    sk: `${Date.now()}_${randomUUID()}`,
    action,
    resourceType,
    resourceId,
    userId,
    timestamp: new Date().toISOString(),
    details: details || {}
  };
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

function getUserFromEvent(event: APIGatewayProxyEvent): { userId: string; role: Role } {
  const userId = event.headers['x-user-id'] || 'anonymous';
  const roleHeader = event.headers['x-user-role'] || 'viewer';
  const role = validateRole(roleHeader);
  return { userId, role };
}

function getResourceTypeFromPath(path: string): string {
  const segments = path.split('/');
  if (segments.length >= 3 && segments[1] === 'api') {
    const resourceIndex = parseInt(segments[2]);
    if (resourceIndex >= 0 && resourceIndex < RESOURCE_TYPES.length) {
      return RESOURCE_TYPES[resourceIndex];
    }
  }
  return 'resources';
}

function generateId(resourceType: string): string {
  const prefixes: Record<string, string> = {
    'orders': 'ord',
    'price-negotiations': 'neg',
    'market-prices': 'mkt',
    'monthly-aggregations': 'agg',
    'purchase-patterns': 'ptn',
    'price-strategies': 'str',
    'customer-price-comparisons': 'cmp'
  };
  const prefix = prefixes[resourceType] || 'res';
  return `${prefix}_${randomUUID()}`;
}

function addTimestamps(item: any, isUpdate: boolean = false): any {
  const now = new Date().toISOString();
  if (!isUpdate) {
    item.createdAt = now;
  }
  item.updatedAt = now;
  return item;
}

function validateOrderData(data: any): string[] {
  const errors: string[] = [];
  if (!data.orderNumber) errors.push('orderNumber is required');
  if (!data.supplierCode) errors.push('supplierCode is required');
  if (!data.supplierName) errors.push('supplierName is required');
  if (!data.productCode) errors.push('productCode is required');
  if (!data.productName) errors.push('productName is required');
  if (typeof data.quantity !== 'number' || data.quantity <= 0) errors.push('quantity must be a positive number');
  if (typeof data.unitPrice !== 'number' || data.unitPrice <= 0) errors.push('unitPrice must be a positive number');
  if (typeof data.totalAmount !== 'number' || data.totalAmount <= 0) errors.push('totalAmount must be a positive number');
  if (!data.orderDate) errors.push('orderDate is required');
  if (!data.deliveryDate) errors.push('deliveryDate is required');
  if (!data.orderStatus) errors.push('orderStatus is required');
  if (!data.integrationStatus) errors.push('integrationStatus is required');
  if (!data.createdBy) errors.push('createdBy is required');
  if (!data.updatedBy) errors.push('updatedBy is required');
  return errors;
}

function validatePriceNegotiation(data: any): string[] {
  const errors: string[] = [];
  if (!data.customerId) errors.push('customerId is required');
  if (!data.productId) errors.push('productId is required');
  if (!data.negotiationStartDate) errors.push('negotiationStartDate is required');
  if (typeof data.currentPrice !== 'number' || data.currentPrice <= 0) errors.push('currentPrice must be a positive number');
  if (typeof data.proposedPrice !== 'number' || data.proposedPrice <= 0) errors.push('proposedPrice must be a positive number');
  if (!data.negotiationStatus) errors.push('negotiationStatus is required');
  if (!data.negotiationReason) errors.push('negotiationReason is required');
  if (!data.salesRepId) errors.push('salesRepId is required');
  if (!data.createdBy) errors.push('createdBy is required');
  return errors;
}

function validateMarketPrice(data: any): string[] {
  const errors: string[] = [];
  if (!data.productCode) errors.push('productCode is required');
  if (!data.productName) errors.push('productName is required');
  if (typeof data.marketPrice !== 'number' || data.marketPrice <= 0) errors.push('marketPrice must be a positive number');
  if (!data.priceDate) errors.push('priceDate is required');
  if (!data.priceSource) errors.push('priceSource is required');
  if (typeof data.isActive !== 'boolean') errors.push('isActive must be a boolean');
  if (!data.createdBy) errors.push('createdBy is required');
  return errors;
}

function validateMonthlyAggregation(data: any): string[] {
  const errors: string[] = [];
  if (!data.targetMonth) errors.push('targetMonth is required');
  if (typeof data.orderCount !== 'number' || data.orderCount < 0) errors.push('orderCount must be a non-negative number');
  if (typeof data.totalOrderAmount !== 'number' || data.totalOrderAmount < 0) errors.push('totalOrderAmount must be a non-negative number');
  if (typeof data.averageUnitPrice !== 'number' || data.averageUnitPrice < 0) errors.push('averageUnitPrice must be a non-negative number');
  if (typeof data.priceNegotiationCount !== 'number' || data.priceNegotiationCount < 0) errors.push('priceNegotiationCount must be a non-negative number');
  if (typeof data.successfulNegotiationCount !== 'number' || data.successfulNegotiationCount < 0) errors.push('successfulNegotiationCount must be a non-negative number');
  if (typeof data.costReduction !== 'number') errors.push('costReduction must be a number');
  if (typeof data.marketPriceDeviationRate !== 'number') errors.push('marketPriceDeviationRate must be a number');
  if (typeof data.monthlyGrowthRate !== 'number') errors.push('monthlyGrowthRate must be a number');
  if (!data.aggregationStatus) errors.push('aggregationStatus is required');
  if (!data.createdBy) errors.push('createdBy is required');
  return errors;
}

function validatePurchasePattern(data: any): string[] {
  const errors: string[] = [];
  if (!data.analysisStartDate) errors.push('analysisStartDate is required');
  if (!data.analysisEndDate) errors.push('analysisEndDate is required');
  if (typeof data.purchaseFrequency !== 'number' || data.purchaseFrequency < 0) errors.push('purchaseFrequency must be a non-negative number');
  if (typeof data.averageOrderQuantity !== 'number' || data.averageOrderQuantity < 0) errors.push('averageOrderQuantity must be a non-negative number');
  if (typeof data.averageUnitPrice !== 'number' || data.averageUnitPrice < 0) errors.push('averageUnitPrice must be a non-negative number');
  if (typeof data.marketPriceDeviationRate !== 'number') errors.push('marketPriceDeviationRate must be a number');
  if (!data.priceSensitivity) errors.push('priceSensitivity is required');
  if (!data.analysisExecutionDate) errors.push('analysisExecutionDate is required');
  if (!data.analysisUserId) errors.push('analysisUserId is required');
  return errors;
}

function validatePriceStrategy(data: any): string[] {
  const errors: string[] = [];
  if (!data.targetProductCode) errors.push('targetProductCode is required');
  if (!data.targetProductName) errors.push('targetProductName is required');
  if (!data.analysisStartDate) errors.push('analysisStartDate is required');
  if (!data.analysisEndDate) errors.push('analysisEndDate is required');
  if (typeof data.currentUnitPrice !== 'number' || data.currentUnitPrice <= 0) errors.push('currentUnitPrice must be a positive number');
  if (typeof data.recommendedUnitPrice !== 'number' || data.recommendedUnitPrice <= 0) errors.push('recommendedUnitPrice must be a positive number');
  if (typeof data.marketAverageUnitPrice !== 'number' || data.marketAverageUnitPrice <= 0) errors.push('marketAverageUnitPrice must be a positive number');
  if (typeof data.priceCompetitivenessIndex !== 'number') errors.push('priceCompetitivenessIndex must be a number');
  if (typeof data.salesForecast !== 'number' || data.salesForecast < 0) errors.push('salesForecast must be a non-negative number');
  if (typeof data.profitMargin !== 'number') errors.push('profitMargin must be a number');
  if (!data.analysisMethod) errors.push('analysisMethod is required');
  if (!data.strategyCategory) errors.push('strategyCategory is required');
  if (!data.riskAssessment) errors.push('riskAssessment is required');
  if (!data.implementationRecommendation) errors.push('implementationRecommendation is required');
  if (!data.approvalStatus) errors.push('approvalStatus is required');
  if (!data.createdBy) errors.push('createdBy is required');
  return errors;
}

function validateCustomerPriceComparison(data: any): string[] {
  const errors: string[] = [];
  if (!data.customerId) errors.push('customerId is required');
  if (!data.productId) errors.push('productId is required');
  if (!data.analysisStartDate) errors.push('analysisStartDate is required');
  if (!data.analysisEndDate) errors.push('analysisEndDate is required');
  if (typeof data.customerUnitPrice !== 'number' || data.customerUnitPrice <= 0) errors.push('customerUnitPrice must be a positive number');
  if (typeof data.marketAverageUnitPrice !== 'number' || data.marketAverageUnitPrice <= 0) errors.push('marketAverageUnitPrice must be a positive number');
  if (typeof data.allCustomerAverageUnitPrice !== 'number' || data.allCustomerAverageUnitPrice <= 0) errors.push('allCustomerAverageUnitPrice must be a positive number');
  if (typeof data.marketComparisonDifference !== 'number') errors.push('marketComparisonDifference must be a number');
  if (typeof data.marketComparisonRate !== 'number') errors.push('marketComparisonRate must be a number');
  if (typeof data.allCustomerComparisonDifference !== 'number') errors.push('allCustomerComparisonDifference must be a number');
  if (typeof data.allCustomerComparisonRate !== 'number') errors.push('allCustomerComparisonRate must be a number');
  if (!data.priceRank) errors.push('priceRank is required');
  if (typeof data.transactionQuantity !== 'number' || data.transactionQuantity < 0) errors.push('transactionQuantity must be a non-negative number');
  if (typeof data.transactionCount !== 'number' || data.transactionCount < 0) errors.push('transactionCount must be a non-negative number');
  if (!data.createdBy) errors.push('createdBy is required');
  return errors;
}

function validateResourceData(resourceType: string, data: any): string[] {
  switch (resourceType) {
    case 'orders':
      return validateOrderData(data);
    case 'price-negotiations':
      return validatePriceNegotiation(data);
    case 'market-prices':
      return validateMarketPrice(data);
    case 'monthly-aggregations':
      return validateMonthlyAggregation(data);
    case 'purchase-patterns':
      return validatePurchasePattern(data);
    case 'price-strategies':
      return validatePriceStrategy(data);
    case 'customer-price-comparisons':
      return validateCustomerPriceComparison(data);
    default:
      return ['Invalid resource type'];
  }
}

async function handleGetResources(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  try {
    const { role } = getUserFromEvent(event);
    
    if (!hasPermission(role, 'read')) {
      return createResponse(403, { error: 'Insufficient permissions' });
    }

    const resourceType = getResourceTypeFromPath(event.path);
    
    const command = new ScanCommand({
      TableName: TABLE_NAME,
      FilterExpression: 'resourceType = :resourceType',
      ExpressionAttributeValues: {
        ':resourceType': resourceType
      }
    });

    const result = await docClient.send(command);
    
    return createResponse(200, {
      items: result.Items || [],
      count: result.Count || 0
    });
  } catch (error) {
    console.error('Error getting resources:', error);
    return createResponse(500, { error: 'Internal server error' });
  }
}

async function handleGetResource(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  try {
    const { role } = getUserFromEvent(event);
    
    if (!hasPermission(role, 'read')) {
      return createResponse(403, { error: 'Insufficient permissions' });
    }

    const resourceId = event.pathParameters?.id;
    if (!resourceId) {
      return createResponse(400, { error: 'Resource ID is required' });
    }

    const resourceType = getResourceTypeFromPath(event.path);
    
    const command = new GetCommand({
      TableName: TABLE_NAME,
      Key: {
        pk: resourceType,
        sk: resourceId
      }
    });

    const result = await docClient.send(command);
    
    if (!result.Item) {
      return createResponse(404, { error: 'Resource not found' });
    }

    return createResponse(200, result.Item);
  } catch (error) {
    console.error('Error getting resource:', error);
    return createResponse(500, { error: 'Internal server error' });
  }
}

async function handleCreateResource(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  try {
    const { userId, role } = getUserFromEvent(event);
    
    if (!hasPermission(role, 'write')) {
      return createResponse(403, { error: 'Insufficient permissions' });
    }

    if (!event.body) {
      return createResponse(400, { error: 'Request body is required' });
    }

    const resourceType = getResourceTypeFromPath(event.path);
    const data = JSON.parse(event.body);
    
    const validationErrors = validateResourceData(resourceType, data);
    if (validationErrors.length > 0) {
      return createResponse(400, { error: 'Validation failed', details: validationErrors });
    }

    const resourceId = generateId(resourceType);
    const item = {
      pk: resourceType,
      sk: resourceId,
      ...addTimestamps(data),
      resourceType
    };

    const command = new PutCommand({
      TableName: TABLE_NAME,
      Item: item
    });

    await docClient.send(command);

    // Create audit log
    const auditLog = createAuditLog('CREATE', resourceType, resourceId, userId, { item });
    await docClient.send(new PutCommand({
      TableName: TABLE_NAME,
      Item: auditLog
    }));

    return createResponse(201, item);
  } catch (error) {
    console.error('Error creating resource:', error);
    return createResponse(500, { error: 'Internal server error' });
  }
}

async function handleUpdateResource(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  try {
    const { userId, role } = getUserFromEvent(event);
    
    if (!hasPermission(role, 'write')) {
      return createResponse(403, { error: 'Insufficient permissions' });
    }

    const resourceId = event.pathParameters?.id;
    if (!resourceId) {
      return createResponse(400, { error: 'Resource ID is required' });
    }

    if (!event.body) {
      return createResponse(400, { error: 'Request body is required' });
    }

    const resourceType = getResourceTypeFromPath(event.path);
    const data = JSON.parse(event.body);
    
    // Check if resource exists
    const getCommand = new GetCommand({
      TableName: TABLE_NAME,
      Key: {
        pk: resourceType,
        sk: resourceId
      }
    });

    const existingResult = await docClient.send(getCommand);
    if (!existingResult.Item) {
      return createResponse(404, { error: 'Resource not found' });
    }

    const validationErrors = validateResourceData(resourceType, data);
    if (validationErrors.length > 0) {
      return createResponse(400, { error: 'Validation failed', details: validationErrors });
    }

    const updatedItem = {
      ...existingResult.Item,
      ...addTimestamps(data, true),
      pk: resourceType,
      sk: resourceId,
      resourceType
    };

    const putCommand = new PutCommand({
      TableName: TABLE_NAME,
      Item: updatedItem
    });

    await docClient.send(putCommand);

    // Create audit log
    const auditLog = createAuditLog('UPDATE', resourceType, resourceId, userId, { 
      before: existingResult.Item,
      after: updatedItem
    });
    await docClient.send(new PutCommand({
      TableName: TABLE_NAME,
      Item: auditLog
    }));

    return createResponse(200, updatedItem);
  } catch (error) {
    console.error('Error updating resource:', error);
    return createResponse(500, { error: 'Internal server error' });
  }
}

async function handleDeleteResource(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  try {
    const { userId, role } = getUserFromEvent(event);
    
    if (!hasPermission(role, 'delete')) {
      return createResponse(403, { error: 'Insufficient permissions' });
    }

    const resourceId = event.pathParameters?.id;
    if (!resourceId) {
      return createResponse(400, { error: 'Resource ID is required' });
    }

    const resourceType = getResourceTypeFromPath(event.path);
    
    // Check if resource exists
    const getCommand = new GetCommand({
      TableName: TABLE_NAME,
      Key: {
        pk: resourceType,
        sk: resourceId
      }
    });

    const existingResult = await docClient.send(getCommand);
    if (!existingResult.Item) {
      return createResponse(404, { error: 'Resource not found' });
    }

    const deleteCommand = new DeleteCommand({
      TableName: TABLE_NAME,
      Key: {
        pk: resourceType,
        sk: resourceId
      }
    });

    await docClient.send(deleteCommand);

    // Create audit log
    const auditLog = createAuditLog('DELETE', resourceType, resourceId, userId, { 
      deletedItem: existingResult.Item
    });
    await docClient.send(new PutCommand({
      TableName: TABLE_NAME,
      Item: auditLog
    }));

    return createResponse(200, { message: 'Resource deleted successfully' });
  } catch (error) {
    console.error('Error deleting resource:', error);
    return createResponse(500, { error: 'Internal server error' });
  }
}

async function handleBulkImport(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  try {
    const { userId, role } = getUserFromEvent(event);
    
    if (!hasPermission(role, 'write')) {
      return createResponse(403, { error: 'Insufficient permissions' });
    }

    if (!event.body) {
      return createResponse(400, { error: 'Request body is required' });
    }

    const { items } = JSON.parse(event.body);
    if (!Array.isArray(items)) {
      return createResponse(400, { error: 'Items must be an array' });
    }

    const resourceType = getResourceTypeFromPath(event.path);
    let imported = 0;
    let failed = 0;
    const errors: string[] = [];

    // Process items in batches of 25 (DynamoDB BatchWrite limit)
    for (let i = 0; i < items.length; i += 25) {
      const batch = items.slice(i, i + 25);
      const writeRequests = [];

      for (const item of batch) {
        try {
          const validationErrors = validateResourceData(resourceType, item);
          if (validationErrors.length > 0) {
            failed++;
            errors.push(`Item ${i + batch.indexOf(item)}: ${validationErrors.join(', ')}`);
            continue;
          }

          const resourceId = generateId(resourceType);
          const processedItem = {
            pk: resourceType,
            sk: resourceId,
            ...addTimestamps(item),
            resourceType
          };

          writeRequests.push({
            PutRequest: {
              Item: processedItem
            }
          });
        } catch (error) {
          failed++;
          errors.push(`Item ${i + batch.indexOf(item)}: ${error}`);
        }
      }

      if (writeRequests.length > 0) {
        try {
          const batchCommand = new BatchWriteCommand({
            RequestItems: {
              [TABLE_NAME]: writeRequests
            }
          });

          await docClient.send(batchCommand);
          imported += writeRequests.length;
        } catch (error) {
          failed += writeRequests.length;
          errors.push(`Batch write error: ${error}`);
        }
      }
    }

    // Create audit log for bulk import
    const auditLog = createAuditLog('BULK_IMPORT', resourceType, 'bulk', userId, {
      totalItems: items.length,
      imported,
      failed
    });
    await docClient.send(new PutCommand({
      TableName: TABLE_NAME,
      Item: auditLog
    }));

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
    const method = event.httpMethod;
    const path = event.path;

    // Handle bulk import endpoint
    if (method === 'POST' && path.includes('/bulk')) {
      return await handleBulkImport(event);
    }

    // Handle regular CRUD operations
    switch (method) {
      case 'GET':
        if (event.pathParameters?.id) {
          return await handleGetResource(event);
        } else {
          return await handleGetResources(event);
        }
      case 'POST':
        return await handleCreateResource(event);
      case 'PUT':
        return await handleUpdateResource(event);
      case 'DELETE':
        return await handleDeleteResource(event);
      default:
        return createResponse(405, { error: 'Method not allowed' });
    }
  } catch (error) {
    console.error('Unhandled error:', error);
    return createResponse(500, { error: 'Internal server error' });
  }
};