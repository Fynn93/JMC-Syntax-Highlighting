import {
	createConnection,
	TextDocuments,
	ProposedFeatures,
	InitializeParams,
	DidChangeConfigurationNotification,
	CompletionItem,
	TextDocumentSyncKind,
	InitializeResult,
	CompletionItemKind,
	FileChangeType,
} from "vscode-languageserver/node";
import { TextDocument } from "vscode-languageserver-textdocument";
import * as get_files from "get-all-files";
import * as url from "url";
import { Lexer } from "../lexer";
import * as fs from "fs/promises";
import {
	ExtractedTokens,
	HJMCFile,
	JMCFile,
	getFunctions,
	getVariablesDeclare,
} from "../helpers/general";
import {
	concatFuncsTokens,
	concatVariableTokens,
	getTokens,
} from "./serverHelper";
import { HeaderParser } from "../parseHeader";

let jmcConfigs: string[] = [];
let jmcFiles: JMCFile[] = [];
let hjmcFiles: HJMCFile[] = [];
let extracted: ExtractedTokens = {
	variables: [],
	funcs: [],
};
export let currentFile: string | undefined;

//#region default
const connection = createConnection(ProposedFeatures.all);
const documents: TextDocuments<TextDocument> = new TextDocuments(TextDocument);

let hasConfigurationCapability = false;
let hasWorkspaceFolderCapability = false;
let hasDiagnosticRelatedInformationCapability = false;
//#endregion
connection.onInitialize(async (params: InitializeParams) => {
	if (params.workspaceFolders) {
		for (const folder of params.workspaceFolders) {
			const files = get_files
				.getAllFilesSync(url.fileURLToPath(folder.uri))
				.toArray();
			jmcConfigs = jmcConfigs.concat(
				files.filter((v) => v.endsWith("jmc_config.json"))
			);
			const jfiles = files.filter(
				(v) => v.endsWith(".jmc") || v.endsWith(".hjmc")
			);
			for (const f of jfiles) {
				const text = await fs.readFile(f, "utf-8");
				if (f.endsWith(".jmc")) {
					jmcFiles.push({
						path: f,
						lexer: new Lexer(text),
					});
				} else if (f.endsWith(".hjmc")) {
					hjmcFiles.push({
						path: f,
						parser: new HeaderParser(text),
					});
				}
			}

			extracted = await getTokens(jmcFiles);
		}
	}

	//#region default
	const capabilities = params.capabilities;

	hasConfigurationCapability = !!(
		capabilities.workspace && !!capabilities.workspace.configuration
	);
	hasWorkspaceFolderCapability = !!(
		capabilities.workspace && !!capabilities.workspace.workspaceFolders
	);
	hasDiagnosticRelatedInformationCapability = !!(
		capabilities.textDocument &&
		capabilities.textDocument.publishDiagnostics &&
		capabilities.textDocument.publishDiagnostics.relatedInformation
	);

	const result: InitializeResult = {
		capabilities: {
			textDocumentSync: TextDocumentSyncKind.Incremental,
			// Tell the client that this server supports code completion.
			completionProvider: {
				resolveProvider: true,
			},
			signatureHelpProvider: {
				triggerCharacters: ["("],
			},
		},
	};
	if (hasWorkspaceFolderCapability) {
		result.capabilities.workspace = {
			workspaceFolders: {
				supported: true,
			},
		};
	}
	return result;
	//#endregion
});

connection.onInitialized(() => {
	if (hasConfigurationCapability) {
		// Register for all configuration changes.
		connection.client.register(
			DidChangeConfigurationNotification.type,
			undefined
		);
	}
	if (hasWorkspaceFolderCapability) {
		connection.workspace.onDidChangeWorkspaceFolders((_event) => {
			connection.console.log("Workspace folder change event received.");
		});
	}
});

interface ServerSettings {
	maxNumberOfProblems: number;
}

const defaultSettings: ServerSettings = { maxNumberOfProblems: 1000 };
let globalSettings: ServerSettings = defaultSettings;

const documentSettings: Map<string, Thenable<ServerSettings>> = new Map();

connection.onDidChangeConfiguration((change) => {
	if (hasConfigurationCapability) {
		documentSettings.clear();
	} else {
		globalSettings = <ServerSettings>(
			(change.settings.languageServerExample || defaultSettings)
		);
	}

	documents.all().forEach(validateTextDocument);
});

function getDocumentSettings(resource: string): Thenable<ServerSettings> {
	if (!hasConfigurationCapability) {
		return Promise.resolve(globalSettings);
	}
	let result = documentSettings.get(resource);
	if (!result) {
		result = connection.workspace.getConfiguration({
			scopeUri: resource,
			section: "jmc",
		});
		documentSettings.set(resource, result);
	}
	return result;
}

documents.onDidClose((e) => {
	documentSettings.delete(e.document.uri);
});

documents.onDidChangeContent((change) => {
	validateTextDocument(change.document);
});

async function validateJMC(fileText: string, path: string): Promise<Lexer> {
	const lexer = new Lexer(fileText);
	currentFile = path;
	jmcFiles = jmcFiles.map((v) => {
		if (v.path == path) v.lexer = lexer;
		return v;
	});
	return lexer;
}

async function validateHJMC(
	fileText: string,
	path: string
): Promise<HeaderParser> {
	const parser = new HeaderParser(fileText);
	currentFile = path;
	hjmcFiles = hjmcFiles.map((v) => {
		if (v.path == path) v.parser == parser;
		return v;
	});
	return parser;
}

async function validateTextDocument(textDocument: TextDocument): Promise<void> {
	const settings = await getDocumentSettings(textDocument.uri);

	const path = url.fileURLToPath(textDocument.uri);
	if (path.endsWith(".jmc")) {
		const lexer = await validateJMC(textDocument.getText(), path);

		const funcs = await getFunctions(lexer);
		const vars = await getVariablesDeclare(lexer);

		extracted.variables = extracted.variables.map((v) => {
			if (v.path == path) v.tokens = vars;
			return v;
		});
		extracted.funcs = extracted.funcs.map((v) => {
			if (v.path == path) v.tokens = funcs;
			return v;
		});
	} else if (path.endsWith(".hjmc")) {
		const parser = await validateHJMC(textDocument.getText(), path);
	}
}

connection.onDefinition((v) => {
	// const document = documents.get(v.textDocument.uri);
	// if (document) {
	// 	const file = jmcFiles.find(
	// 		(val) => val.path == url.fileURLToPath(v.textDocument.uri)
	// 	);
	// 	if (file) {
	// 		const index = file.lexer.tokens.findIndex((val) => {
	// 			return val.pos < document.offsetAt(v.position);
	// 		});
	// 		console.log(file.lexer.tokens[index]);
	// 	}
	// }
	return [];
});

connection.onCompletion(
	async (arg, token, progress, result): Promise<CompletionItem[]> => {
		const vars: CompletionItem[] = concatVariableTokens(extracted).map(
			(v) => {
				return {
					label: v.value.slice(1),
					insertText: v.value,
					kind: CompletionItemKind.Variable,
				};
			}
		);
		const funcs: CompletionItem[] = concatFuncsTokens(extracted).map(
			(v) => {
				return {
					label: v.value,
					insertText: v.value + "()",
					kind: CompletionItemKind.Function,
				};
			}
		);
		return vars.concat(funcs);
	}
);

connection.onCompletionResolve((item: CompletionItem): CompletionItem => {
	return item;
});

connection.onSignatureHelp((handler) => {
	return handler.context?.activeSignatureHelp;
});

//data methods
connection.onRequest("data/getFile", (path: string): JMCFile | undefined => {
	return jmcFiles.find((v) => v.path == path);
});
connection.onRequest("data/getFiles", (path: string): JMCFile[] => {
	return jmcFiles;
});
connection.onRequest("data/getExtracted", (): ExtractedTokens => {
	return extracted;
});

//file operation
connection.onRequest(
	"file/update",
	async (path: string): Promise<Lexer | HeaderParser | undefined> => {
		if (path.endsWith(".jmc"))
			return await validateJMC(await fs.readFile(path, "utf-8"), path);
		else if (path.endsWith(".hjmc"))
			return await validateHJMC(await fs.readFile(path, "utf-8"), path);
		else return undefined;
	}
);

connection.onRequest("file/add", (file: JMCFile): number => {
	return jmcFiles.push(file);
});

connection.onRequest("file/add", (file: HJMCFile): number => {
	return hjmcFiles.push(file);
});

connection.onRequest("file/remove", (path: string): void => {
	for (let i = 0; i < jmcFiles.length; i++) {
		if (jmcFiles[i].path == path) {
			jmcFiles.splice(i, 1);
			return;
		}
	}
	for (let i = 0; i < hjmcFiles.length; i++) {
		if (hjmcFiles[i].path == path) {
			hjmcFiles.splice(i, 1);
			return;
		}
	}
});

documents.listen(connection);
connection.listen();
