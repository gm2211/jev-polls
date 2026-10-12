/** Shared interaction chrome rules; research content stays selectable by default. */
export const TEXT_SELECTION_CSS = `
button,.button,select,label,summary,nav,[role=button],[role=tab],[role=switch],.topbar,.brand,.field-label,.ui-icon,.eyebrow,.section-kicker,.micro-label,.pagination{ -webkit-user-select:none;user-select:none }
input,textarea,[contenteditable]:not([contenteditable=false]){ -webkit-user-select:text;user-select:text }
input[type=button],input[type=submit],input[type=reset]{ -webkit-user-select:none;user-select:none }
`;

/** Workspace only: the app is chrome by default, so nothing but produced content can be selected. Research content opts back in: what people typed, persona profiles and sources, answers, Jev's drafts and replies, code to copy, and error text. */
export const WORKSPACE_SELECTION_CSS = `
body,dialog{ -webkit-user-select:none;user-select:none }
pre,code,.agent-code,.source-line,.persona-story,.persona-facts,.persona-comparison,.host-member-detail,.lv-detail,.lv-answers,.proposal-explanation,.proposal-summary,.command-status,.draft-progress-detail,.review-step-details,.workspace-error,[role=alert]{ -webkit-user-select:text;user-select:text }
`;
