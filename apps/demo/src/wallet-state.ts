interface StateWithWallet {wallet:{id:string;revision:string|number}}

// Concurrent polling and SSE refreshes may observe different wallet revisions.
export function withLatestWallet<T extends StateWithWallet>(current:T|null,next:T):T{
 if(current?.wallet.id===next.wallet.id&&BigInt(current.wallet.revision)>BigInt(next.wallet.revision))return {...next,wallet:current.wallet};
 return next;
}
