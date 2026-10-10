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
function plural(n,one,many){return Number(n).toLocaleString('en-US')+' '+(n===1?one:many||one+'s')}
function markdownInline(text){
  const toks=[];
  String(text??'').split(/(\x60[^\x60\n]+\x60)/).forEach(part=>{
    if(/^\x60[^\x60\n]+\x60$/.test(part)){toks.push({code:part.slice(1,-1)});return}
    part.split('**').forEach((piece,i)=>{if(i)toks.push({mark:true});if(piece)toks.push({text:piece})});
  });
  const marks=toks.filter(t=>t.mark).length,literalFrom=marks%2?toks.map(t=>!!t.mark).lastIndexOf(true):-1;
  let open=false,out='';
  toks.forEach((t,i)=>{
    if(t.mark){if(i===literalFrom)out+='**';else{out+=open?'</strong>':'<strong>';open=!open}}
    else out+=t.code!==undefined?'<code>'+esc(t.code)+'</code>':esc(t.text);
  });
  return out;
}
function markdownInlineSteps(line){
  const m=/^(.*?:)\s+(1[.)]\s.*)$/.exec(line);if(!m)return null;
  const items=m[2].split(/\s+(?=\d{1,2}[.)]\s)/);
  if(items.length<2||!items.every((item,i)=>new RegExp('^'+(i+1)+'[.)]\\s+\\S').test(item)))return null;
  return {lead:m[1],items:items.map(item=>item.replace(/^\d+[.)]\s+/,''))};
}
function markdownHtml(text){
  const out=[];let para=[],list=null;
  const flushPara=()=>{if(para.length){out.push('<p>'+para.map(markdownInline).join('<br>')+'</p>');para=[]}};
  const flushList=()=>{if(list){out.push('<'+list.tag+'>'+list.items.map(item=>'<li>'+markdownInline(item)+'</li>').join('')+'</'+list.tag+'>');list=null}};
  const addItem=(tag,item)=>{if(list&&list.tag!==tag)flushList();(list||(list={tag,items:[]})).items.push(item)};
  for(const raw of String(text??'').replace(/\r\n?/g,'\n').split('\n')){
    const line=raw.trimEnd(),bullet=/^\s*[-*]\s+(.*)$/.exec(line),numbered=/^\s*\d{1,3}[.)]\s+(.*)$/.exec(line),inline=!bullet&&!numbered?markdownInlineSteps(line.trim()):null;
    if(!line.trim()){flushPara();flushList()}
    else if(bullet){flushPara();addItem('ul',bullet[1])}
    else if(numbered){flushPara();addItem('ol',numbered[1])}
    else if(inline){flushPara();flushList();out.push('<p>'+markdownInline(inline.lead)+'</p>');inline.items.forEach(item=>addItem('ol',item));flushList()}
    else{flushList();para.push(line.trim())}
  }
  flushPara();flushList();return out.join('');
}
`;
