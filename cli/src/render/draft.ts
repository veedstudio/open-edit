/** The --out every draft takes, so a draft can be told from the deliverable by its name. */
export const DRAFT_OUT = /\.draft\.(mp4|mov)$/i;

/** Why `command` will not take `file`, named as a draft is, as the video to deliver; null for any other name. */
export function draftRefusal(file: string, command: string): string | null {
  return DRAFT_OUT.test(file)
    ? `${file} has a --draft render's name, and a draft is a quick look drawn at half size with the fastest encode, never the deliverable: `
      + `render the page again without --draft and give ${command} that video`
    : null;
}
