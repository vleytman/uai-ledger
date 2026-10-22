import {createAdminBackend} from '@uai/admin-module/server';
export {readPath,commandPath} from '@uai/admin-module/server';
// Register trusted, owner-only product handlers alongside the UAI module.
export const handle=createAdminBackend({reads:{},commands:{}});
