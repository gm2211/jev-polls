/** Every modal closes on a click outside it, through the same action its own close button runs. A press that starts inside a modal and ends outside it (a text drag) never closes it. Modals holding typed text, and the command palette while an AI request runs, stay open and say how to leave. */
export const MODAL_DISMISS_CLIENT = String.raw`
const MODAL_TYPED_FIELDS={importDialog:'#importJson',authDialog:'#authKey',answerListDialog:'#answerListText'};
let modalPress=null;
function modalOutside(e){
  const t=e.target;if(!t)return null;
  if(t.classList?.contains('command-backdrop'))return {kind:'command',node:t};
  if(t.tagName==='DIALOG'&&t.open){const r=t.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)return {kind:'dialog',node:t}}
  return null;
}
function modalHasTypedText(dialog){
  const field=MODAL_TYPED_FIELDS[dialog.id]&&dialog.querySelector(MODAL_TYPED_FIELDS[dialog.id]);
  if(field?.value.trim())return true;
  return dialog.id==='answerListDialog'&&typeof answerListDraft!=='undefined'&&!!answerListDraft?.fileText;
}
function modalDismiss(hit){
  if(hit.kind==='command'){if(commandState.busy){say('Jev is still working on your request. Press Esc to stop it.');return}commandClose();return}
  const dialog=hit.node;
  if(modalHasTypedText(dialog)){say('Your text is still here. Close the dialog to discard it.');return}
  const close=dialog.querySelector('[data-act$="-close"]');
  if(close)close.click();else dialog.close();
}
document.addEventListener('pointerdown',e=>{modalPress=e.button===0?modalOutside(e):null},true);
document.addEventListener('click',e=>{
  const press=modalPress;modalPress=null;if(!press)return;
  const hit=modalOutside(e);if(!hit||hit.node!==press.node)return;
  e.preventDefault();e.stopPropagation();
  try{modalDismiss(hit)}catch(error){fail(error)}
},true);
`;
