"""Portable statement checkpoints for a restricted, deterministic CPython program.

Only compile the locally supplied source. Peer data never supplies code or object hooks.
This module does not inspect other processes, execute I/O, or snapshot the host heap.
"""

import ast
import hashlib
import json
import sys
from pathlib import Path

MAX_STATE = 256 * 1024
MAX_SOURCE = 96 * 1024
BUILTINS = {f.__name__: f for f in (abs, len, max, min, sum)}
RESERVED = set(BUILTINS) | {"range", "print"}
EXPRESSIONS = (
    ast.Constant,
    ast.Name,
    ast.Load,
    ast.List,
    ast.Subscript,
    ast.BinOp,
    ast.UnaryOp,
    ast.BoolOp,
    ast.Compare,
    ast.IfExp,
    ast.Add,
    ast.Sub,
    ast.Mult,
    ast.FloorDiv,
    ast.Mod,
    ast.BitAnd,
    ast.BitOr,
    ast.BitXor,
    ast.USub,
    ast.UAdd,
    ast.Invert,
    ast.Not,
    ast.And,
    ast.Or,
    ast.Eq,
    ast.NotEq,
    ast.Lt,
    ast.LtE,
    ast.Gt,
    ast.GtE,
)


def require(ok, why):
    if not ok:
        raise ValueError(why)


def encode(value):
    return json.dumps(
        value, ensure_ascii=True, separators=(",", ":"), sort_keys=True
    ).encode("ascii")


def scalar(value):
    return (
        value is None
        or type(value) is bool
        or (type(value) is int and value.bit_length() <= 4096)
    )


def safe_name(name):
    return name.isidentifier() and not name.startswith("__") and name not in RESERVED


def expression(node):
    transient_ranges = {
        id(arg)
        for call in ast.walk(node)
        if isinstance(call, ast.Call)
        and isinstance(call.func, ast.Name)
        and call.func.id in {"sum", "min", "max", "len"}
        for arg in call.args
        if isinstance(arg, ast.Call)
        and isinstance(arg.func, ast.Name)
        and arg.func.id == "range"
    }
    called = {id(n.func) for n in ast.walk(node) if isinstance(n, ast.Call)}
    for child in ast.walk(node):
        if isinstance(child, ast.Call):
            require(
                isinstance(child.func, ast.Name)
                and (child.func.id in BUILTINS or id(child) in transient_ranges)
                and not child.keywords,
                f"Unsupported call at line {child.lineno}",
            )
        elif isinstance(child, ast.Name):
            require(safe_name(child.id) or id(child) in called, "Reserved name")
        elif isinstance(child, ast.Constant):
            require(
                scalar(child.value),
                "Only bounded integer, boolean and None constants are supported",
            )
        else:
            require(
                isinstance(child, EXPRESSIONS),
                f"Unsupported expression: {type(child).__name__}",
            )
    return compile(ast.Expression(node), "<checkpoint-expression>", "eval")


def validate_target(target):
    if isinstance(target, ast.Name) and safe_name(target.id):
        return
    if (
        isinstance(target, ast.Subscript)
        and isinstance(target.value, ast.Name)
        and safe_name(target.value.id)
    ):
        expression(target.slice)
        return
    raise ValueError("Assignment needs a variable or a named list element")


class Program:
    """Use CPython for each original expression/assignment, keep only the resumable control edges."""

    def __init__(self, path, interval):
        require(
            sys.implementation.name == "cpython" and sys.version_info[:2] == (3, 11),
            "Use CPython 3.11 on both devices",
        )
        require(
            1 <= interval <= 65536, "Checkpoint interval outside 1..65536 statements"
        )
        with Path(path).open("rb") as stream:
            source = stream.read(MAX_SOURCE + 1)
        require(len(source) <= MAX_SOURCE, "Source too large")
        source = source.decode("utf-8-sig").replace("\r\n", "\n").replace("\r", "\n")
        tree = ast.parse(source)
        require(len(list(ast.walk(tree))) <= 12000, "Program too large")
        self.interval = interval
        runner = hashlib.sha256(
            Path(__file__).read_text(encoding="utf-8-sig").encode("utf-8")
        ).hexdigest()
        self.recipe = hashlib.sha256(
            f"dsh-cpython-state/v1:3.11:{runner}:{interval}:".encode() + source.encode()
        ).hexdigest()
        self.ops = []
        self.owners = []
        self.owner = ""
        self.locals = {}
        self.parameters = {}
        self.entries = {}
        self.range_slots = set()
        definitions = []
        while tree.body and isinstance(tree.body[0], ast.FunctionDef):
            fn = tree.body.pop(0)
            args = fn.args
            require(
                safe_name(fn.name)
                and fn.name not in self.parameters
                and not fn.decorator_list
                and fn.returns is None
                and not (
                    args.vararg
                    or args.kwarg
                    or args.defaults
                    or args.kwonlyargs
                    or args.posonlyargs
                ),
                "Expected ordinary positional functions before module statements",
            )
            params = [a.arg for a in args.args]
            require(
                len(params) == len(set(params))
                and all(a.annotation is None and safe_name(a.arg) for a in args.args),
                "Invalid function parameters",
            )
            self.parameters[fn.name] = params
            definitions.append(fn)
        for fn in definitions:
            self.owner = fn.name
            self.check_names(fn.body, self.parameters[fn.name])
            self.entries[fn.name] = self.block(fn.body, self.add("return", None), None)
        self.owner = ""
        self.check_names(tree.body, [])
        self.result = None
        if tree.body and isinstance(tree.body[-1], ast.Expr):
            call = tree.body[-1].value
            if (
                isinstance(call, ast.Call)
                and isinstance(call.func, ast.Name)
                and call.func.id == "print"
            ):
                require(
                    len(call.args) == 1 and not call.keywords,
                    "Expected a single final print(value)",
                )
                self.result = expression(call.args[0])
                tree.body.pop()
        end = self.add("result", self.result) if self.result is not None else -1
        self.entry = self.block(tree.body, end, None)

    def check_names(self, statements, parameters):
        nodes = list(ast.walk(ast.Module(body=statements, type_ignores=[])))
        names = set(parameters) | {
            n.id
            for n in nodes
            if isinstance(n, ast.Name) and isinstance(n.ctx, ast.Store)
        }
        require(
            not names.intersection(self.parameters),
            "Function names cannot be overwritten",
        )
        called = {id(n.func) for n in nodes if isinstance(n, ast.Call)}
        for n in nodes:
            if isinstance(n, ast.Name) and isinstance(n.ctx, ast.Load):
                require(
                    n.id in names
                    or n.id in RESERVED
                    or (n.id in self.parameters and id(n) in called),
                    f"Undeclared input or nonlocal: {n.id}",
                )
        self.locals[self.owner] = names

    def add(self, *op):
        self.owners.append(self.owner)
        self.ops.append(op)
        return len(self.ops) - 1

    def block(self, statements, after, loop):
        for node in reversed(statements):
            if isinstance(node, (ast.Assign, ast.AugAssign)):
                for target in (
                    node.targets if isinstance(node, ast.Assign) else [node.target]
                ):
                    validate_target(target)
                call = node.value
                if (
                    isinstance(call, ast.Call)
                    and isinstance(call.func, ast.Name)
                    and call.func.id in self.parameters
                ):
                    require(
                        isinstance(node, ast.Assign)
                        and len(node.targets) == 1
                        and isinstance(node.targets[0], ast.Name)
                        and not call.keywords
                        and len(call.args) == len(self.parameters[call.func.id]),
                        "Assign a positional function result to one variable",
                    )
                    after = self.add(
                        "call",
                        call.func.id,
                        [expression(expr) for expr in call.args],
                        node.targets[0].id,
                        after,
                    )
                    continue
                expression(node.value)
                if isinstance(node, ast.AugAssign):
                    require(
                        isinstance(node.op, EXPRESSIONS),
                        "Unsupported augmented assignment",
                    )
                code = compile(
                    ast.Module(body=[node], type_ignores=[]),
                    "<checkpoint-assignment>",
                    "exec",
                )
                after = self.add("assign", code, after)
            elif isinstance(node, ast.Return) and self.owner:
                after = self.add(
                    "return", expression(node.value) if node.value is not None else None
                )
            elif isinstance(node, ast.If):
                after = self.add(
                    "if",
                    expression(node.test),
                    self.block(node.body, after, loop),
                    self.block(node.orelse, after, loop),
                )
            elif isinstance(node, (ast.For, ast.While)):
                exit_pc = self.block(node.orelse, after, loop)
                header = self.add("pending")
                cleanup = self.add("break", header, after)
                body = self.block(node.body, header, (header, cleanup))
                if isinstance(node, ast.While):
                    self.ops[header] = ("if", expression(node.test), body, exit_pc)
                else:
                    it = node.iter
                    require(
                        isinstance(node.target, ast.Name)
                        and safe_name(node.target.id)
                        and isinstance(it, ast.Call)
                        and isinstance(it.func, ast.Name)
                        and it.func.id == "range"
                        and 1 <= len(it.args) <= 3
                        and not it.keywords,
                        "Only for <name> in range(...) is supported",
                    )
                    self.range_slots.add(str(header))
                    self.ops[header] = (
                        "range",
                        [expression(x) for x in it.args],
                        node.target.id,
                        body,
                        exit_pc,
                    )
                after = header
            elif isinstance(node, (ast.Break, ast.Continue)) and loop:
                after = self.add("jump", loop[1 if isinstance(node, ast.Break) else 0])
            elif isinstance(node, ast.Pass):
                after = self.add("jump", after)
            else:
                raise ValueError(
                    f"Unsupported statement at line {node.lineno}: {type(node).__name__}"
                )
        return after


class Machine:
    def __init__(self, program):
        self.program = program
        self.pc = program.entry
        self.stack = []
        self.output = None
        self.steps = 0
        self.values = {}
        self.ranges = {}

    def advance(self):
        scope = {"__builtins__": BUILTINS | {"range": range}}

        def read(code):
            return eval(code, scope, self.values)

        for _ in range(self.program.interval):
            if self.pc == -1:
                break
            op, *args = self.program.ops[self.pc]
            if op == "assign":
                code, self.pc = args
                exec(code, scope, self.values)
            elif op == "result":
                value = read(args[0])
                require(
                    scalar(value)
                    or (type(value) is list and all(scalar(item) for item in value)),
                    "Final print accepts a scalar or a flat list of scalars",
                )
                self.output = str(value)
                self.pc = -1
            elif op == "call":
                name, exprs, var, after = args
                require(len(self.stack) < 128, "Call stack exceeds 128 frames")
                values = dict(
                    zip(self.program.parameters[name], [read(code) for code in exprs])
                )
                self.stack.append((self.pc, self.values, self.ranges))
                self.pc, self.values, self.ranges = (
                    self.program.entries[name],
                    values,
                    {},
                )
            elif op == "return":
                result = read(args[0]) if args[0] is not None else None
                caller, self.values, self.ranges = self.stack.pop()
                _, _, _, var, self.pc = self.program.ops[caller]
                self.values[var] = result
            elif op == "if":
                cond, yes, no = args
                self.pc = yes if read(cond) else no
            elif op == "range":
                exprs, var, body, end = args
                slot = str(self.pc)
                if slot not in self.ranges:
                    r = range(*(read(code) for code in exprs))
                    self.ranges[slot] = [r.start, r.stop, r.step]
                n, stop, step = self.ranges[slot]
                if n < stop if step > 0 else n > stop:
                    self.values[var] = n
                    self.ranges[slot][0] += step
                    self.pc = body
                else:
                    del self.ranges[slot]
                    self.pc = end
            elif op == "break":
                self.ranges.pop(str(args[0]), None)
                self.pc = args[1]
            else:
                self.pc = args[0]
            self.steps += 1

    def snapshot(self):
        # List identity matters: two variables (or nested lists) may reference the same mutable buffer.
        indices, pending, heap = {}, [], []

        def ref(obj):
            if scalar(obj):
                return obj
            require(
                type(obj) is list,
                "Unsupported local state; previous checkpoint remains intact",
            )
            if id(obj) not in indices:
                indices[id(obj)] = len(pending)
                pending.append(obj)
            return [indices[id(obj)]]

        def frame(pc, values, ranges):
            for cursor in ranges.values():
                require(
                    all(scalar(i) for i in cursor),
                    "Range cursor exceeds checkpoint budget",
                )
            return dict(
                pc=pc, names={k: ref(values[k]) for k in sorted(values)}, ranges=ranges
            )

        callers = [frame(pc, v, r) for pc, v, r in self.stack]
        active = frame(self.pc, self.values, self.ranges)
        cells = 0
        for buf in pending:
            cells += len(buf) + 1
            require(cells <= MAX_STATE // 2, "Heap exceeds checkpoint budget")
            heap.append([ref(item) for item in buf])
        data = encode(
            dict(
                recipe=self.program.recipe,
                steps=self.steps,
                heap=heap,
                stack=callers,
                output=self.output,
                **active,
            )
        )
        require(len(data) <= MAX_STATE, "Checkpoint exceeds 256 KiB")
        return data

    @classmethod
    def restore(cls, program, data):
        require(len(data) <= MAX_STATE, "Oversized checkpoint")
        s = json.loads(data)
        require(
            isinstance(s, dict)
            and set(s)
            == {"recipe", "steps", "pc", "names", "heap", "ranges", "stack", "output"}
            and s["recipe"] == program.recipe,
            "Checkpoint does not match source/interval/runtime",
        )
        require(
            type(s["pc"]) is int
            and -1 <= s["pc"] < len(program.ops)
            and type(s["steps"]) is int
            and 0 <= s["steps"] < 2**63,
            "Invalid checkpoint position",
        )
        require(
            type(s["heap"]) is list
            and type(s["stack"]) is list
            and len(s["stack"]) <= 128,
            "Invalid heap or stack",
        )
        buffers = [[] for _ in s["heap"]]

        def value(item):
            if scalar(item):
                return item
            require(
                type(item) is list
                and len(item) == 1
                and type(item[0]) is int
                and 0 <= item[0] < len(buffers),
                "Invalid heap reference",
            )
            return buffers[item[0]]

        for buf, raw in zip(buffers, s["heap"]):
            require(type(raw) is list, "Invalid heap buffer")
            buf.extend(value(item) for item in raw)

        def read_frame(f, owner):
            require(
                type(f) is dict and set(f) == {"pc", "names", "ranges"},
                "Invalid execution frame",
            )
            pc, names, ranges = f["pc"], f["names"], f["ranges"]
            require(
                type(pc) is int
                and (
                    (pc == -1 and not owner)
                    or (0 <= pc < len(program.ops) and program.owners[pc] == owner)
                ),
                "Invalid frame location",
            )
            require(
                type(names) is dict and names.keys() <= program.locals[owner],
                "Invalid frame variables",
            )
            require(
                type(ranges) is dict and ranges.keys() <= program.range_slots,
                "Invalid range slots",
            )
            for slot, cursor in ranges.items():
                require(
                    program.owners[int(slot)] == owner
                    and type(cursor) is list
                    and len(cursor) == 3
                    and all(type(i) is int and scalar(i) for i in cursor)
                    and cursor[2] != 0,
                    "Invalid range cursor",
                )
            return pc, {k: value(v) for k, v in names.items()}, ranges

        m = cls(program)
        owner = ""
        for f in s["stack"]:
            caller = read_frame(f, owner)
            pc = caller[0]
            require(
                pc >= 0 and program.ops[pc][0] == "call",
                "Frame is not a suspended call",
            )
            owner = program.ops[pc][1]
            m.stack.append(caller)
        m.pc, m.values, m.ranges = read_frame(
            {k: s[k] for k in ("pc", "names", "ranges")}, owner
        )
        m.steps = s["steps"]
        if m.pc == -1 and program.result is not None:
            require(type(s["output"]) is str, "Missing saved result")
        else:
            require(s["output"] is None, "Unexpected output before completion")
        m.output = s["output"]
        return m

    def final_text(self):
        require(self.pc == -1, "Program still running")
        return self.output


def slice_once(program, raw):
    """A native sandbox may only be able to exchange opaque state through relay_script_checkpoint."""
    import base64

    machine = Machine(program)
    if raw:
        machine = Machine.restore(program, base64.b64decode(raw, validate=True))
        machine.advance()
    data = machine.snapshot()
    done = machine.pc == -1
    return dict(
        recipe=program.recipe,
        steps=machine.steps,
        done=done,
        state=base64.b64encode(data).decode("ascii"),
        result=machine.final_text() if done else None,
    )


def main():
    import argparse

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["check", "slice"])
    parser.add_argument("script", type=Path)
    parser.add_argument("--interval", type=int, default=512)
    args = parser.parse_args()
    program = Program(args.script, args.interval)
    if args.action == "check":
        print(
            json.dumps(
                dict(
                    recipe=program.recipe,
                    interval=program.interval,
                    instructions=len(program.ops),
                )
            )
        )
    else:
        limit = 4 * ((MAX_STATE + 2) // 3)
        raw = sys.stdin.buffer.read(limit + 2).strip()
        require(len(raw) <= limit, "Oversized input")
        print(json.dumps(slice_once(program, raw)))


if __name__ == "__main__":
    main()
