#!/usr/bin/env python3
"""
Valida todas as consultas SQL estáticas do código (sem interpolação ${...}) com PREPARE no PostgreSQL real.
Pega erro de sintaxe, tabela/coluna inexistente e tipo de parâmetro ambíguo — sem precisar subir o servidor.
Uso: DATABASE_URL="$TEST_DATABASE_URL" python3 server/scripts/sql-smoke.py
"""
import os, re, subprocess, sys, glob

dsn = sys.argv[1] if len(sys.argv) > 1 else os.environ.get("DATABASE_URL", "")
root = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "src")
KW = re.compile(r"^\s*(SELECT|INSERT|UPDATE|DELETE|WITH)\b", re.I)
found, failed = 0, 0
for path in sorted(glob.glob(os.path.join(root, "**", "*.ts"), recursive=True)):
    src = open(path, encoding="utf8").read()
    for m in re.finditer(r"`([^`]*)`", src):
        sql = m.group(1)
        if "${" in sql or not KW.match(sql) or " FROM " not in sql.upper() and not re.match(r"^\s*(INSERT|UPDATE|DELETE)", sql, re.I):
            continue
        line = src.count("\n", 0, m.start()) + 1
        found += 1
        stmt = f"PREPARE s{found} AS {sql.strip().rstrip(';')};"
        r = subprocess.run(["psql", dsn, "-v", "ON_ERROR_STOP=1", "-q", "-c", stmt], capture_output=True, text=True)
        if r.returncode != 0:
            failed += 1
            print(f"FALHA {os.path.relpath(path, root)}:{line}\n  {r.stderr.strip().splitlines()[0]}\n  {' '.join(sql.split())[:160]}\n")
print(f"{found} consultas verificadas, {failed} com erro")
sys.exit(1 if failed else 0)
