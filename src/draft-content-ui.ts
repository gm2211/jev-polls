/** Browser helpers shared by drafting panels: attached text material, safe markdown, and count labels. */
export const DRAFT_CONTENT_CLIENT = String.raw`
const MATERIAL_MAX_BYTES=256*1024;
async function materialReadFile(file){
  if(!/\.(txt|md|csv|json)$/i.test(file.name))throw Error('Choose a TXT, Markdown, CSV or JSON file.');
  if(file.size>MATERIAL_MAX_BYTES)throw Error('File is too large. Maximum size is 256 KiB.');
  const text=await file.text();
  if(new TextEncoder().encode(text).length>MATERIAL_MAX_BYTES)throw Error('File is too large. Maximum size is 256 KiB.');
  if(text.includes('\u0000')||text.includes('�'))throw Error('Use a UTF-8 text file. Binary or invalid text cannot be read.');
  if(!text.trim())throw Error('File is empty. Choose a file with your candidate names or notes.');
  return text;
}
function plural(n,one,many){return n+' '+(n===1?one:many||one+'s')}
function markdownInline(text){
  return String(text??'').split(/(\x60[^\x60\n]+\x60)/).map(part=>/^\x60[^\x60\n]+\x60$/.test(part)?'<code>'+esc(part.slice(1,-1))+'</code>':esc(part).replace(/\*\*([^*\n]+?)\*\*/g,'<strong>$1</strong>')).join('');
}
function markdownHtml(text){
  const out=[];let para=[],list=null;
  const flushPara=()=>{if(para.length){out.push('<p>'+para.map(markdownInline).join('<br>')+'</p>');para=[]}};
  const flushList=()=>{if(list){out.push('<ul>'+list.map(item=>'<li>'+markdownInline(item)+'</li>').join('')+'</ul>');list=null}};
  for(const raw of String(text??'').replace(/\r\n?/g,'\n').split('\n')){
    const line=raw.trimEnd(),bullet=/^\s*[-*]\s+(.*)$/.exec(line);
    if(!line.trim()){flushPara();flushList()}
    else if(bullet){flushPara();(list||(list=[])).push(bullet[1])}
    else{flushList();para.push(line.trim())}
  }
  flushPara();flushList();return out.join('');
}
`;
