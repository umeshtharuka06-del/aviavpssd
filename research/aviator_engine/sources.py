"""Registry of the public files the engine may read, with provenance and the role each may play.

Roles (never mixed in one analysis):
  real_candidate     third-party rounds claimed to be real Aviator play; analysed per series
  negative_control   real data from a different game, used only to check that tests do not raise false alarms
  synthetic          generated data, null-model control only
  excluded           not analysed (a mirror, derived features, or no data); audited and reported only
"""

from __future__ import annotations

from dataclasses import dataclass, field

RAW = "https://raw.githubusercontent.com"


@dataclass(frozen=True)
class SourceFile:
    file_id: str
    repo: str
    path: str
    branch: str
    licence: str | None
    role: str
    kind: str  # loader key
    sha256: str | None = None
    notes: tuple[str, ...] = field(default_factory=tuple)

    @property
    def url(self) -> str:
        return f"{RAW}/{self.repo}/{self.branch}/{self.path}"

    @property
    def local_name(self) -> str:
        return f"{self.file_id}__{self.path.rsplit('/', 1)[-1]}"


SOURCES: tuple[SourceFile, ...] = (
    SourceFile(
        "A1", "hddvision/research-data", "datasets/DATA-001/multipliers.csv", "master", "MIT", "excluded", "multipliers",
        "d7f495ef47af02c660669d2b9905fc0d40f6a182aa954c4430e522fd73d77fef",
        ("Mirror: byte-identical to B1 and to MindingTheData/Crash-Analysis multipliers.csv (2020).",),
    ),
    SourceFile(
        "A2", "hddvision/research-data", "datasets/DATA-001/aviator_dataset-1.csv", "master", "MIT", "excluded", "timestamped",
        "cd2cf0478bf5817fc45ae488da9a67f805d528232fb93fcbc27f7c144fa7b5a4",
        ("Mirror of C1 (same rows, different line endings).",),
    ),
    SourceFile(
        "B1", "Waqas56jb/aviator-multiplier-prediction-ml", "dataset/multipliers.csv", "main", "MIT", "negative_control", "multipliers",
        "d7f495ef47af02c660669d2b9905fc0d40f6a182aa954c4430e522fd73d77fef",
        ("Same bytes as MindingTheData/Crash-Analysis multipliers.csv: a bustabit-style hash chain, not Aviator.",
         "No timestamps, round ids or operator; file order assumed chronological but unverifiable."),
    ),
    SourceFile(
        "B2", "Waqas56jb/aviator-multiplier-prediction-ml", "dataset/aviator_dataset_clean.csv", "main", "MIT", "excluded", "derived",
        "e2e8038c8e02a962544e104d11161cb5f678b86aebac4a2ea4dadd9b0fbe376d",
        ("Derived features of B1 (color, mean, var, next_approximate, target); audited for target leakage only.",),
    ),
    SourceFile(
        "C1", "HananAIBuilds/aviator-ml-analysis", "aviator_dataset-1.csv", "main", None, "real_candidate", "timestamped",
        "577fcb61e9438d4b7c61cfa82e70406a9e1c539bb6d31f611c4be4773f9e83e3",
        ("No licence: analyse locally, do not redistribute.", "Operator not stated."),
    ),
    SourceFile(
        "P1", "PHIMAS/aviator", "aviator_payouts.csv", "main", None, "real_candidate", "payouts",
        "63e2f2c7d8f363be42a9716b91f0a7ecb11e87be2acff03274fd4a6a1ab9b9e1",
        ("Dataset used by kakarla07/aviator-crash-analysis (Kaggle waruingugi/aviator); that repository has no data of its own.",
         "Four Kenyan operators; each operator is a separate series."),
    ),
    SourceFile(
        "S1", "hddvision/stochastic-crash-pipeline", "data/raw/crash_dataset.csv", "main", None, "synthetic", "synthetic",
        "09a53fdece5a0050dc2ae02993fd05112c58f430c72dd641cb6779f6d5e16fe6",
        ("Monte Carlo, piecewise-uniform generator; NOT game data.",),
    ),
)

#: Repositories inspected that contain no dataset of their own.
NO_DATA_REPOS = {
    "kakarla07/aviator-crash-analysis": "Code and README only; reads Kaggle waruingugi/aviator (= P1).",
}

BY_ID = {s.file_id: s for s in SOURCES}
