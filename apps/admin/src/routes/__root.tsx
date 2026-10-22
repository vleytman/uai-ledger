import {application} from '../application';
import {HeadContent,Scripts,createRootRoute} from '@tanstack/react-router';
import appCss from '../styles.css?url';
export const Route=createRootRoute({
 head:()=>({meta:[{charSet:'utf-8'},{name:'viewport',content:'width=device-width, initial-scale=1'},{title:`${application.brand.name} · Administration`}],links:[{rel:'stylesheet',href:appCss}]}),
 pendingComponent:()=> <main className="p-8" role="status">Loading administration…</main>,
 notFoundComponent:()=> <main className="p-8"><h1 className="mb-3 text-xl font-semibold">Page not found</h1><p className="mb-4">This administration page does not exist.</p><a href="/" className="underline">Return to overview</a></main>,
 errorComponent:({reset})=> <main className="p-8" role="alert"><h1 className="mb-3 text-xl font-semibold">Unable to load this page</h1><p className="mb-4">Please try again. If the problem continues, check the API connection.</p><button onClick={reset} className="underline">Try again</button></main>,
 shellComponent:({children})=><html lang="en"><head><HeadContent/></head><body>{children}<Scripts/></body></html>,
});
