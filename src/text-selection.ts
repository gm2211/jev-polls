/** Shared interaction chrome rules; research content stays selectable by default. */
export const TEXT_SELECTION_CSS = `
button,.button,select,label,summary,nav,[role=button],[role=tab],[role=switch],.topbar,.brand,.field-label,.ui-icon,.eyebrow,.section-kicker,.micro-label,.pagination{ -webkit-user-select:none;user-select:none }
input,textarea,[contenteditable]:not([contenteditable=false]){ -webkit-user-select:text;user-select:text }
input[type=button],input[type=submit],input[type=reset]{ -webkit-user-select:none;user-select:none }
`;
