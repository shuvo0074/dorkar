// The dependency-free subpath keeps the role map out of zod and the event schemas, so the shell
// can decide which links to show without growing the main bundle.
import { permissionsFor, type Permission } from '@dorkar/contracts/authz';
import { useMemo } from 'react';
import { useSession } from './session';

/**
 * What the signed-in account may do, from the roles on its account record. This only decides
 * what the UI offers; every API call is authorized again on the server.
 */
export function useCan(): (permission: Permission) => boolean {
  const { account } = useSession();
  const roles = account?.roles;
  return useMemo(() => {
    const granted = permissionsFor(roles ?? []);
    return (p: Permission) => granted.has(p);
  }, [roles]);
}
