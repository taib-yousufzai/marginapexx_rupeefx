'use client';

import React, { useEffect, useState } from 'react';
import { getSession, getRole } from '@/lib/auth';
import { Permission, hasPermission } from '@/lib/permissions';

interface RequirePermissionProps {
  permission: Permission;
  children: React.ReactNode;
  fallback?: React.ReactNode;
}

export function RequirePermission({ permission, children, fallback = null }: RequirePermissionProps) {
  const [isAllowed, setIsAllowed] = useState<boolean | null>(true);

  useEffect(() => {
    let cancelled = false;
    getSession().then((session) => {
      if (cancelled) return;
      if (!session || !session.user) {
        setIsAllowed(permission.startsWith('VIEW_OWN_'));
        return;
      }
      
      const role = getRole(session.user);
      if (hasPermission(role, permission)) {
        setIsAllowed(true);
      } else {
        setIsAllowed(false);
      }
    });
    return () => { cancelled = true; };
  }, [permission]);

  if (isAllowed === null) return <>{children}</>;

  return isAllowed ? <>{children}</> : <>{fallback}</>;
}
