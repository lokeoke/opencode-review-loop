// One definition shared by both client parts, so the name and description cannot drift apart.
export const COMMAND_NAME = 'review-loop';
export const COMMAND_DESCRIPTION = 'review and auto-fix changes [pr|--base branch], defaults to uncommitted | status | stop';
export const INPUT_WARNING = 'New user input in the owning session stops the review loop. Use /review-loop status to follow it or /review-loop stop to cancel.';
