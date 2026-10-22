import {authenticateRequest,requestTransaction} from './request-principal.js';
import type {FastifyInstance} from 'fastify';
import type pg from 'pg';
import {apiSchemas} from '../../../packages/contracts/api.js';
import {requireScopes} from '../../../packages/auth/src/index.js';
import {DomainError,type Clock} from '../../../packages/contracts/src/index.js';
import {CatalogService} from '../../../packages/catalog/src/index.js';

export function registerPriceComparison(app:FastifyInstance,pool:pg.Pool,clock:Clock){app.post('/v1/admin/rate-cards/compare',async request=>requestTransaction(pool,request,async tx=>{const p=await authenticateRequest(tx,request);requireScopes(p,'operations:admin');if(p.account_ids)throw new DomainError('scope_denied','Installation administrator required',403);return new CatalogService(tx,clock).compareRates(p,apiSchemas.AdminPriceCompareBody.parse(request.body));}));}
