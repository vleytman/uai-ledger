import type {StaffRole,ExternalIdentity} from '../../contracts/external-identity.js';
import type {ComponentType} from 'react';
import type {AdminBrand, ModuleDefinition, PageDefinition} from '@uai/admin-shell';
export interface AdminPageContext {
  /** Local owner-administration session. This is not a customer authorization grant. */
  session: { authenticated: boolean; account_id: string; wallet_id: string; mode?:'standalone'|'external'; identity?:Extract<ExternalIdentity,{kind:'staff'}>|null; role?:StaffRole; capabilities?:{readViews:string[];actions:string[]} };
  refresh: number;
  navigate: (view: string) => void;
}
export interface AdminPage extends PageDefinition { component: ComponentType<AdminPageContext> }
export interface AdminApplication {
  brand: AdminBrand;
  modules: readonly ModuleDefinition<AdminPage>[];
}
export const standaloneApplication: AdminApplication = {
  brand: {name:'uai',tagline:'SPEND MANAGEMENT'}, modules:[],
};
