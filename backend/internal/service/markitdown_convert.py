#!/usr/bin/env python3
"""Convert a single file to markdown via the markitdown library.

Invoked by ToolsService.ToMarkdown (see tools.go), which embeds this script
into the server binary and writes it to a temp file at startup. Reads LLM
configuration from the process environment -- populated at server startup
from --env/.env -- so image descriptions are LLM-generated when an API key
is present, and skipped otherwise. Prints the resulting markdown to stdout.
"""
import os
import sys

from markitdown import MarkItDown


def build_llm_client():
    api_key = os.environ.get("OPENAI_API_KEY")
    model = os.environ.get("MARKITDOWN_LLM_MODEL")
    if not api_key or not model:
        return None, None
    try:
        from openai import OpenAI
    except ImportError:
        print("markitdown_convert: OPENAI_API_KEY/MARKITDOWN_LLM_MODEL set but the "
              "'openai' package is not installed; falling back to non-LLM conversion",
              file=sys.stderr)
        return None, None
    base_url = os.environ.get("OPENAI_BASE_URL") or None
    client = OpenAI(api_key=api_key, base_url=base_url)
    return client, model


def convert_pdf(path):
    """Layout-aware PDF -> markdown via pymupdf4llm.

    markitdown's own PdfConverter is pdfminer plain-text extraction: headings,
    bold, lists, and table structure are all lost, and its llm_client is only
    ever used for image description -- never for PDF layout. pymupdf4llm
    reconstructs headings/tables/emphasis from font geometry, so PDFs keep
    their structure. Returns None if pymupdf4llm is not installed, in which
    case the caller falls back to markitdown.
    """
    try:
        import pymupdf4llm
    except ImportError:
        print("markitdown_convert: pymupdf4llm not installed; PDF will convert "
              "as plain text (pip install pymupdf4llm to keep PDF structure)",
              file=sys.stderr)
        return None
    return pymupdf4llm.to_markdown(path)


def main():
    if len(sys.argv) != 2:
        print("usage: markitdown_convert.py <input-file>", file=sys.stderr)
        sys.exit(2)

    path = sys.argv[1]
    if path.lower().endswith(".pdf"):
        text = convert_pdf(path)
        if text is not None:
            sys.stdout.write(text)
            return

    client, model = build_llm_client()
    md = MarkItDown(llm_client=client, llm_model=model) if client else MarkItDown()
    result = md.convert(path)
    sys.stdout.write(result.text_content)


if __name__ == "__main__":
    main()
