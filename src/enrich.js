const {
  getFileKind,
  getDiffFilePath,
  isDependencyFile,
  isStyleFile
} = require("./util");

function enrichParsedDiff(parsed) {
  for (const file of parsed.files) {
    const filePath = getDiffFilePath(file);
    file.kind = getFileKind(filePath);

    for (const hunk of file.hunks) {
      hunk.insight = summarizeHunk(file, hunk);
    }

    file.tags = getFileTags(file, filePath);
    file.weight = getFileWeight(file);
  }

  parsed.totals.weight = parsed.files.reduce((sum, file) => sum + file.weight, 0);
}

function summarizeHunk(file, hunk) {
  const added = hunk.lines.filter((line) => line.type === "add");
  const deleted = hunk.lines.filter((line) => line.type === "delete");
  const changedText = [...added, ...deleted].map((line) => line.content).join("\n");
  const labels = [];
  const filePath = getDiffFilePath(file);

  if (isDependencyFile(filePath)) {
    labels.push("dependency");
  }
  if (/\b(import|export)\b.+\bfrom\b|require\(|import\(/.test(changedText)) {
    labels.push("imports");
  }
  if (/\bexport\s+(?:default\s+)?(const|function|class|interface|type|enum)\b/.test(changedText)) {
    labels.push("exports");
  }
  if (/\b(if|else|switch|case|return|throw|try|catch|await|async)\b/.test(changedText)) {
    labels.push("logic");
  }
  if (/\b(type|interface|enum)\b/.test(changedText)) {
    labels.push("types");
  }
  if (/\b(fetch|axios|graphql|query|mutation|endpoint|route|api)\b/i.test(changedText)) {
    labels.push("data");
  }
  if (/\b(test|describe|it|expect|mock|stub)\b/i.test(filePath + "\n" + changedText)) {
    labels.push("tests");
  }
  if (isStyleFile(filePath) || /(--[\w-]+|#[0-9a-f]{3,8}\b|rgba?\(|display:|grid|flex)/i.test(changedText)) {
    labels.push("styles");
  }
  if (/<[A-Z][\w.]*|className=|use[A-Z]\w+/.test(changedText)) {
    labels.push("ui");
  }

  const uniqueLabels = [...new Set(labels)];
  return {
    title: getHunkTitle(uniqueLabels, hunk),
    labels: uniqueLabels.slice(0, 4),
    added: added.length,
    deleted: deleted.length,
    balance: added.length > deleted.length ? "expanded" : added.length < deleted.length ? "reduced" : "changed"
  };
}

function getHunkTitle(labels, hunk) {
  if (labels.includes("dependency")) {
    return "Dependency surface changed";
  }
  if (labels.includes("imports")) {
    return "Connections changed";
  }
  if (labels.includes("exports")) {
    return "Public surface changed";
  }
  if (labels.includes("data")) {
    return "Data path changed";
  }
  if (labels.includes("logic")) {
    return "Behavior changed";
  }
  if (labels.includes("ui")) {
    return "UI structure changed";
  }
  if (labels.includes("styles")) {
    return "Visual styling changed";
  }
  if (labels.includes("tests")) {
    return "Test coverage changed";
  }
  if (labels.includes("types")) {
    return "Type contract changed";
  }
  return hunk.section ? "Local change" : "Code changed";
}

function getFileTags(file, filePath) {
  const tags = [getFileKind(filePath)];
  if (file.binary) {
    tags.push("binary");
  }
  if (isDependencyFile(filePath)) {
    tags.push("dependency");
  }
  if (file.hunks.some((hunk) => hunk.insight && hunk.insight.labels.includes("imports"))) {
    tags.push("imports");
  }
  if (file.additions + file.deletions > 120) {
    tags.push("large");
  }
  return [...new Set(tags)].filter(Boolean);
}

function getFileWeight(file) {
  const lineWeight = Math.min(file.additions + file.deletions, 200);
  const hunkWeight = file.hunks.length * 6;
  const statusWeight = file.status === "added" || file.status === "deleted" ? 12 : 0;
  return lineWeight + hunkWeight + statusWeight;
}

module.exports = {
  enrichParsedDiff,
  summarizeHunk,
  getHunkTitle,
  getFileTags,
  getFileWeight
};
