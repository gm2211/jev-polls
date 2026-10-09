/** Inline project rename on the project list: a pencil opens the name field, the check icon saves it. */
export const PROJECT_RENAME_CLIENT = String.raw`
function projectRenameRow(p){
  return '<form class="project-list-row project-rename" data-form="project-rename" data-id="'+attr(p.id)+'"><label class="project-rename-field"><input name="name" value="'+attr(p.name)+'" required maxlength="160" aria-label="Project name" autocomplete="off"></label>'
    +'<button class="button primary small icon-button" type="submit" title="Save project name" aria-label="Save project name">'+icon('check')+'</button>'
    +'<button class="button small icon-button" type="button" data-act="project-rename-cancel" title="Cancel rename" aria-label="Cancel rename">'+icon('close')+'</button></form>';
}
function projectRenameButton(p){return '<button type="button" class="button small icon-button project-rename-open" data-act="project-rename" data-id="'+attr(p.id)+'" aria-label="Rename project: '+attr(p.name)+'" title="Rename project">'+icon('edit')+'</button>'}
function projectRenameAction(a,el){
  if(a==='project-rename'){S.projectRename=el.dataset.id;render();const input=root.querySelector('[data-form=project-rename] [name=name]');input?.focus();input?.select?.();return true}
  if(a==='project-rename-cancel'){S.projectRename=null;render();return true}
  return false;
}
function submitProjectRename(form){
  const p=S.doc.projects.find(x=>x.id===form.dataset.id);if(!p){S.projectRename=null;render();return}
  const name=String(new FormData(form).get('name')||'').trim();if(!name)throw Error('Name your project first.');
  S.projectRename=null;if(name===p.name){render();return}
  p.name=name;S.dirty=true;void save();
}
`;

export const PROJECT_RENAME_CSS = String.raw`
.project-list-row>.project-rename-open{flex:none;margin:0 4px 0 0;background:transparent;border-color:transparent;color:var(--muted)}
.project-list-row>.project-rename-open:hover{color:var(--ink)}
.project-rename{gap:8px;padding:12px 12px 12px 20px}
.project-rename-field{flex:1;min-width:0}
.project-rename-field input{width:100%;font:inherit;font-size:18px;font-weight:600}
`;
