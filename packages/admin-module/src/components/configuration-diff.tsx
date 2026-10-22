export interface ConfigurationChange {path:string;before:unknown;after:unknown}
const object=(value:unknown):value is Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value);

/** Keep monetary strings intact and match model/component arrays by identity. */
export function configurationChanges(before:unknown,after:unknown,path='Configuration'):ConfigurationChange[]{
  if(Object.is(before,after))return [];
  if(object(before)&&object(after))return [...new Set([...Object.keys(before),...Object.keys(after)])].flatMap(key=>configurationChanges(before[key],after[key],`${path} / ${key}`));
  if(Array.isArray(before)&&Array.isArray(after)){
    const identity=['id','key'].find(key=>[before,after].every(items=>items.every(item=>object(item)&&typeof item[key]==='string')&&new Set(items.map(item=>item[key])).size===items.length));
    if(identity){
      const previous=new Map(before.map(item=>[item[identity],item])),next=new Map(after.map(item=>[item[identity],item]));
      return [...new Set([...previous.keys(),...next.keys()])].flatMap(key=>configurationChanges(previous.get(key),next.get(key),`${path} / ${key}`));
    }
    return Array.from({length:Math.max(before.length,after.length)},(_,i)=>i).flatMap(i=>configurationChanges(before[i],after[i],`${path} / ${i+1}`));
  }
  return [{path,before,after}];
}
function Value({value}:{value:unknown}){
  if(value===undefined)return <span className="uai-footnote">Not set</span>;
  if(value===null)return <span>None</span>;
  if(typeof value!=='object')return <span style={{overflowWrap:'anywhere',whiteSpace:/^-?\d+(\.\d+)?$/.test(String(value))?'nowrap':undefined}}>{String(value)}</span>;
  const entries=Object.entries(value);
  return <details><summary>{Array.isArray(value)?`${entries.length} items`:'View fields'}</summary><dl>{entries.map(([key,item])=><div key={key}><dt>{key}</dt><dd><Value value={item}/></dd></div>)}</dl></details>;
}
export function ConfigurationDiff({before,after,previousVersion}:{before:unknown;after:unknown;previousVersion?:number}){
  const changes=configurationChanges(before,after);
  return <section aria-label="Version changes" className="admin-configuration-diff">
    <h3>{previousVersion===undefined?'Initial configuration':`Changes from version ${previousVersion}`}</h3>
    {changes.length?<><p className="uai-footnote">{changes.length} changed {changes.length===1?'field':'fields'}. Published versions remain unchanged.</p><div style={{overflowX:'auto'}}><table><thead><tr><th>Setting</th><th>Before</th><th>After</th></tr></thead><tbody>{changes.map(change=><tr key={change.path}><td>{change.path}</td><td><Value value={change.before}/></td><td><Value value={change.after}/></td></tr>)}</tbody></table></div></>:<p>No configuration changes.</p>}
  </section>;
}
