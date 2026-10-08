"""Name normalisation shared by the export and build scripts."""
import re
import unicodedata


def name_key(name):
    """Case/spacing/punctuation/word-order-insensitive key: 'Doe, Jane' == 'jane  DOE'."""
    s = unicodedata.normalize("NFKC", str(name)).casefold()
    tokens = re.findall(r"[^\W_]+(?:['’-][^\W_]+)*", s)
    return " ".join(sorted(tokens))


def clean_name(name):
    return re.sub(r"\s*,\s*", ", ", re.sub(r"\s+", " ", str(name).strip()))
