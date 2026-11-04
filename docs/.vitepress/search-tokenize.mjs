// MiniSearch's default word split treats an unspaced Chinese sentence as one
// token. Index and query Han unigrams and adjacent bigrams, plus Latin words.
export function tokenizeSearch(text) {
  const parts = text.match(/[\u3400-\u9fff]+|[A-Za-z0-9_]+/g) ?? [];
  return parts.flatMap((part) => {
    if (!/^[\u3400-\u9fff]+$/.test(part)) return [part];
    const chars = Array.from(part);
    return chars.flatMap((char, i) => i + 1 < chars.length ? [char, char + chars[i + 1]] : [char]);
  });
}
