export type Role = 'admin' | 'operator' | 'viewer';

export interface Permission {
  resource: string;
  actions: string[];
}

export const ROLE_PERMISSIONS: Record<Role, Permission[]> = {
  admin: [
    { resource: '*', actions: ['*'] }
  ],
  operator: [
    { resource: 'orders', actions: ['read', 'create', 'update'] },
    { resource: 'market-prices', actions: ['read', 'create', 'update'] },
    { resource: 'monthly-summaries', actions: ['read', 'create', 'update'] },
    { resource: 'purchase-patterns', actions: ['read', 'create', 'update'] },
    { resource: 'price-strategies', actions: ['read', 'create', 'update'] },
    { resource: 'customer-price-comparisons', actions: ['read', 'create', 'update'] },
    { resource: 'analysis-reports', actions: ['read', 'create', 'update'] },
    { resource: 'system-logs', actions: ['read', 'create'] },
    { resource: 'bulk', actions: ['create'] }
  ],
  viewer: [
    { resource: 'orders', actions: ['read'] },
    { resource: 'market-prices', actions: ['read'] },
    { resource: 'monthly-summaries', actions: ['read'] },
    { resource: 'purchase-patterns', actions: ['read'] },
    { resource: 'price-strategies', actions: ['read'] },
    { resource: 'customer-price-comparisons', actions: ['read'] },
    { resource: 'analysis-reports', actions: ['read'] },
    { resource: 'system-logs', actions: ['read'] }
  ]
};

export function hasPermission(role: Role, resource: string, action: string): boolean {
  const permissions = ROLE_PERMISSIONS[role];
  
  return permissions.some(permission => {
    const resourceMatch = permission.resource === '*' || permission.resource === resource;
    const actionMatch = permission.actions.includes('*') || permission.actions.includes(action);
    return resourceMatch && actionMatch;
  });
}

export function extractUserRole(event: any): Role {
  const authHeader = event.headers?.Authorization || event.headers?.authorization;
  if (!authHeader) return 'viewer';
  
  // JWT decode simulation - in real implementation, decode and validate JWT
  const token = authHeader.replace('Bearer ', '');
  if (token.includes('admin')) return 'admin';
  if (token.includes('operator')) return 'operator';
  return 'viewer';
}