import org.jd.core.v1.ClassFileToJavaSourceDecompiler;
import org.jd.core.v1.api.loader.Loader;
import org.jd.core.v1.api.loader.LoaderException;
import org.jd.core.v1.api.printer.Printer;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.HashMap;
import java.util.Map;

/**
 * JdCoreDecompiler — a thin CLI around jd-core 1.1.3, the exact decompiler
 * engine used by JD-GUI. Mirrors JD-GUI's ClassFilePage / ClassFileSourceSaver:
 *
 *   DECOMPILER.decompile(loader, printer, entryInternalName, configuration)
 *   configuration: { "realignLineNumbers": bool }
 *   printer options: escapeUnicodeCharacters, showLineNumbers
 *
 * Usage:
 *   java -jar jdcore-wrapper.jar <class-file> [--classpath <dir>]
 *        [--realign true|false] [--escape-unicode true|false]
 *        [--line-numbers true|false]
 *
 * Output: decompiled Java source on stdout (UTF-8). Errors → stderr, exit 1.
 *
 * The printer is a faithful port of JD-GUI's StringBuilderPrinter /
 * LineNumberStringBuilderPrinter (TAB indentation, backslash-uXXXX escaping when
 * requested, `/* n *​/` line-number prefixes when requested).
 */
public class JdCoreDecompiler {

    /** Loader: resolve "<internal>.class" relative to a directory (JD-GUI
     *  ContainerLoader scans the entry's parent directory). */
    static class DirLoader implements Loader {
        private final Path root;      // sibling classpath dir (may be null)
        private final Path mainFile;  // exact class file to decompile
        private final String mainName; // internal name of the main entry

        DirLoader(Path root, Path mainFile, String mainName) {
            this.root = root;
            this.mainFile = mainFile;
            this.mainName = mainName;
        }

        private boolean isMain(String internalPath) {
            return mainName != null && mainName.equals(internalPath);
        }

        private Path resolveSibling(String internalPath) {
            if (root == null) {
                return null;
            }
            Path p = root.resolve(internalPath + ".class").normalize();
            if (!p.startsWith(root)) {
                return null;
            }
            return Files.isRegularFile(p) ? p : null;
        }

        @Override
        public boolean canLoad(String internalPath) {
            return isMain(internalPath) || resolveSibling(internalPath) != null;
        }

        @Override
        public byte[] load(String internalPath) throws LoaderException {
            Path p = isMain(internalPath) ? mainFile : resolveSibling(internalPath);
            if (p == null) {
                return null;
            }
            try (InputStream in = Files.newInputStream(p);
                 ByteArrayOutputStream out = new ByteArrayOutputStream()) {
                byte[] buf = new byte[4096];
                int n;
                while ((n = in.read(buf)) > 0) {
                    out.write(buf, 0, n);
                }
                return out.toByteArray();
            } catch (IOException e) {
                throw new LoaderException(e);
            }
        }
    }

    /** Port of JD-GUI StringBuilderPrinter + LineNumberStringBuilderPrinter. */
    static class SinkPrinter implements Printer {
        static final String TAB = "  ";
        static final String NL = "\n";

        final StringBuilder sb = new StringBuilder(65536);
        /** JD-GUI links: every printReference is a hyperlink bound to the
         *  EXACT output position (stringBuffer.length() = start offset),
         *  carrying the FULL internal type name + member name + descriptor —
         *  never a simple-name lookup. Serialized to stderr as JDREFS lines. */
        // jd-core Printer type constants: TYPE=1, FIELD=2, METHOD=3, CONSTRUCTOR=4.
        static class RefRecord {
            final int start; final int len; final int type;
            final String internalTypeName; final String name; final String descriptor; final String owner;
            RefRecord(int start, int len, int type, String internalTypeName, String name, String descriptor, String owner) {
                this.start = start; this.len = len; this.type = type;
                this.internalTypeName = internalTypeName; this.name = name; this.descriptor = descriptor; this.owner = owner;
            }
        }
        final java.util.List<RefRecord> refs = new java.util.ArrayList<>();
        boolean unicodeEscape;
        boolean realignLineNumbers;
        boolean showLineNumbers;
        int indentationCount;
        int maxLineNumber;
        int digitCount;
        String unknownLineNumberPrefix;
        String lineNumberBeginPrefix;
        String lineNumberEndPrefix;
        int majorVersion;
        int minorVersion;

        SinkPrinter(boolean escapeUnicode, boolean realign, boolean lineNumbers) {
            this.unicodeEscape = escapeUnicode;
            this.realignLineNumbers = realign;
            this.showLineNumbers = lineNumbers;
        }

        int getMajorVersion() { return majorVersion; }
        int getMinorVersion() { return minorVersion; }

        /** JD-GUI escape(): \t kept; <32 → octal \0NN; >127 → backslash-uXXXX only
         *  when unicodeEscape; otherwise appended as-is. */
        void escape(String s) {
            if (unicodeEscape && s != null) {
                for (int i = 0; i < s.length(); i++) {
                    char c = s.charAt(i);
                    if (c == '\t') {
                        sb.append(c);
                    } else if (c < 32) {
                        sb.append("\\0");
                        sb.append((char) ('0' + (c >> 3)));
                        sb.append((char) ('0' + (c & 0x7)));
                    } else if (c > 127) {
                        sb.append(String.format("\\u%04X", (int) c));
                    } else {
                        sb.append(c);
                    }
                }
            } else if (s != null) {
                sb.append(s);
            }
        }

        // ── Printer ──
        @Override public void start(int maxLineNumber, int majorVersion, int minorVersion) {
            sb.setLength(0);
            refs.clear();
            this.majorVersion = majorVersion;
            this.minorVersion = minorVersion;
            this.indentationCount = 0;
            if (showLineNumbers) {
                this.maxLineNumber = maxLineNumber;
                if (maxLineNumber > 0) {
                    digitCount = 1;
                    unknownLineNumberPrefix = " ";
                    int maximum = 9;
                    while (maximum < maxLineNumber) {
                        digitCount++;
                        unknownLineNumberPrefix += ' ';
                        maximum = maximum * 10 + 9;
                    }
                    lineNumberBeginPrefix = "/* ";
                    lineNumberEndPrefix = " */ ";
                } else {
                    unknownLineNumberPrefix = "";
                    lineNumberBeginPrefix = "";
                    lineNumberEndPrefix = "";
                }
            } else {
                this.maxLineNumber = 0;
                unknownLineNumberPrefix = "";
                lineNumberBeginPrefix = "";
                lineNumberEndPrefix = "";
            }
        }

        @Override public void end() {}

        @Override public void printText(String text) { escape(text); }
        @Override public void printNumericConstant(String constant) { escape(constant); }
        @Override public void printStringConstant(String constant, String ownerInternalName) { escape(constant); }
        @Override public void printKeyword(String keyword) { sb.append(keyword); }
        @Override public void printDeclaration(int type, String internalTypeName, String name, String descriptor) { escape(name); }
        @Override public void printReference(int type, String internalTypeName, String name, String descriptor, String ownerInternalName) {
            if (name != null) {
                refs.add(new RefRecord(sb.length(), name.length(), type, internalTypeName, name, descriptor, ownerInternalName));
            }
            escape(name);
        }
        @Override public void indent() { indentationCount++; }
        @Override public void unindent() { if (indentationCount > 0) indentationCount--; }

        @Override public void startLine(int lineNumber) {
            if (maxLineNumber > 0) {
                sb.append(lineNumberBeginPrefix);
                if (lineNumber == Printer.UNKNOWN_LINE_NUMBER) {
                    sb.append(unknownLineNumberPrefix);
                } else {
                    int left = 0;
                    left = printDigit(5, lineNumber, 10000, left);
                    left = printDigit(4, lineNumber, 1000, left);
                    left = printDigit(3, lineNumber, 100, left);
                    left = printDigit(2, lineNumber, 10, left);
                    sb.append((char) ('0' + (lineNumber - left)));
                }
                sb.append(lineNumberEndPrefix);
            }
            for (int i = 0; i < indentationCount; i++) {
                sb.append(TAB);
            }
        }

        int printDigit(int dcv, int lineNumber, int divisor, int left) {
            if (digitCount >= dcv) {
                if (lineNumber < divisor) {
                    sb.append(' ');
                } else {
                    int e = (lineNumber - left) / divisor;
                    sb.append((char) ('0' + e));
                    left += e * divisor;
                }
            }
            return left;
        }

        @Override public void endLine() { sb.append(NL); }

        @Override public void extraLine(int count) {
            if (realignLineNumbers) {
                while (count-- > 0) {
                    if (maxLineNumber > 0) {
                        sb.append(lineNumberBeginPrefix);
                        sb.append(unknownLineNumberPrefix);
                        sb.append(lineNumberEndPrefix);
                    }
                    sb.append(NL);
                }
            }
        }

        @Override public void startMarker(int type) {}
        @Override public void endMarker(int type) {}

        String source() { return sb.toString(); }
    }

    /** Minimal JSON string encoder (quotes, backslash, control chars). */
    static String jsonEncode(String s) {
        if (s == null) return "null";
        StringBuilder b = new StringBuilder(s.length() + 8);
        b.append('"');
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            switch (c) {
                case '"': b.append("\\\""); break;
                case '\\': b.append("\\\\"); break;
                case '\n': b.append("\\n"); break;
                case '\r': b.append("\\r"); break;
                case '\t': b.append("\\t"); break;
                default:
                    if (c < 0x20) b.append(String.format("\\u%04x", (int) c));
                    else b.append(c);
            }
        }
        b.append('"');
        return b.toString();
    }

    public static void main(String[] args) {
        String classFile = null;
        String classpath = ".";
        String internalName = null;
        boolean escapeUnicode = false;
        boolean realign = false;      // JD-GUI display default
        boolean lineNumbers = false;  // JD-GUI display default (save enables)

        for (int i = 0; i < args.length; i++) {
            switch (args[i]) {
                case "--classpath":
                    if (i + 1 < args.length) classpath = args[++i];
                    break;
                case "--internal-name":
                    if (i + 1 < args.length) internalName = args[++i];
                    break;
                case "--escape-unicode":
                    if (i + 1 < args.length) escapeUnicode = Boolean.parseBoolean(args[++i]);
                    break;
                case "--realign":
                    if (i + 1 < args.length) realign = Boolean.parseBoolean(args[++i]);
                    break;
                case "--line-numbers":
                    if (i + 1 < args.length) lineNumbers = Boolean.parseBoolean(args[++i]);
                    break;
                default:
                    if (classFile == null) classFile = args[i];
                    break;
            }
        }

        if (classFile == null) {
            System.err.println("usage: java -jar jdcore-wrapper.jar <class-file> [--classpath <dir>] [--internal-name <internalName>] [--realign true|false] [--escape-unicode true|false] [--line-numbers true|false]");
            System.exit(2);
        }

        try {
            Path cf = Paths.get(classFile).toAbsolutePath().normalize();
            if (!Files.isRegularFile(cf)) {
                System.err.println("class file not found: " + classFile);
                System.exit(1);
            }
            Path cpRoot;
            if (classpath == null || classpath.isEmpty()) {
                // No sibling dir: resolve everything relative to the class
                // file's own directory (CFR --extraclasspath "" behavior).
                cpRoot = cf.getParent();
            } else {
                cpRoot = Paths.get(classpath).toAbsolutePath().normalize();
                if (!Files.isDirectory(cpRoot)) {
                    cpRoot = cf.getParent();
                }
            }

            String entryInternal;
            if (internalName != null && !internalName.isEmpty()) {
                entryInternal = internalName;
            } else if (cf.startsWith(cpRoot)) {
                entryInternal = cpRoot.relativize(cf).toString().replace('\\', '/');
            } else {
                entryInternal = cf.getFileName().toString();
            }
            if (entryInternal.endsWith(".class")) {
                entryInternal = entryInternal.substring(0, entryInternal.length() - 6);
            }

            DirLoader loader = new DirLoader(cpRoot, cf, entryInternal);
            SinkPrinter printer = new SinkPrinter(escapeUnicode, realign, lineNumbers);

            Map<String, Object> config = new HashMap<>();
            config.put("realignLineNumbers", realign);
            config.put("escapeUnicodeCharacters", escapeUnicode);

            ClassFileToJavaSourceDecompiler decompiler = new ClassFileToJavaSourceDecompiler();
            decompiler.decompile(loader, printer, entryInternal, config);

            // JD-GUI hyperlinks: emit the reference table (JSON per line) to
            // stderr so stdout stays pure source text. The Rust side parses
            // these and binds links by exact position.
            for (SinkPrinter.RefRecord r : printer.refs) {
                System.err.println("JDREFS\t" + jsonEncode(String.valueOf(r.start)) + "\t" + jsonEncode(String.valueOf(r.len))
                    + "\t" + r.type + "\t" + jsonEncode(r.internalTypeName) + "\t" + jsonEncode(r.name)
                    + "\t" + jsonEncode(r.descriptor) + "\t" + jsonEncode(r.owner));
            }
            System.out.print(printer.source());
            System.exit(0);
        } catch (Throwable t) {
            System.err.println("decompilation failed: " + t.getMessage());
            t.printStackTrace(System.err);
            System.exit(1);
        }
    }
}
