const { OpenAI } = require('openai');
const { Octokit } = require('@octokit/rest');
const axios = require('axios');
const winston = require('winston');

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.simple(),
  transports: [new winston.transports.Console()]
});

class CodeReviewAgent {
  constructor() {
    this.openai = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY
    });
    
    this.github = new Octokit({
      auth: process.env.GITHUB_TOKEN
    });
  }

  async analyze(params) {
    const { repository, pr_number, diff_url, llm_model } = params;
    const model = llm_model || process.env.OPENAI_MODEL || 'gpt-4o-mini';
    
    try {
      // Fetch the diff from GitHub
      const diffResponse = await axios.get(diff_url, {
        headers: {
          'Authorization': `token ${process.env.GITHUB_TOKEN}`,
          'Accept': 'application/vnd.github.v3.diff'
        }
      });
      
      const diff = diffResponse.data;
      
      // Analyze the code changes with LLM
      const analysis = await this.analyzeDiff(diff, model);
      
      // Post review comments if issues found
      if (analysis.issues.length > 0) {
        await this.postReviewComments(repository, pr_number, analysis.issues);
      }
      
      return {
        status: analysis.approved ? 'approved' : 'changes_requested',
        score: analysis.score,
        issues_found: analysis.issues.length,
        suggestions: analysis.suggestions,
        security_concerns: analysis.security_concerns,
        performance_issues: analysis.performance_issues,
        approved: analysis.approved
      };
      
    } catch (error) {
      logger.error('Code review analysis failed:', error);
      throw error;
    }
  }

  async analyzeDiff(diff, model) {
    const prompt = `
You are an expert code reviewer. Analyze the following code diff and provide:

1. Overall code quality score (0-100)
2. List of issues with severity (critical, major, minor)
3. Security concerns
4. Performance issues
5. Suggestions for improvement
6. Whether to approve the changes

Code diff:
${diff}

Respond with ONLY valid JSON (no markdown formatting):
{
  "score": number,
  "approved": boolean,
  "issues": [{"type": "string", "severity": "string", "message": "string", "line": number}],
  "security_concerns": ["string"],
  "performance_issues": ["string"],
  "suggestions": ["string"]
}
`;

    try {
      const response = await this.openai.chat.completions.create({
        model: model,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.1,
        max_tokens: 2000
      });

      const analysis = this.parseJsonResponse(response.choices[0].message.content);
      
      // Auto-approve if score is high and no critical issues
      const criticalIssues = analysis.issues.filter(issue => issue.severity === 'critical');
      analysis.approved = analysis.score >= 80 && criticalIssues.length === 0;
      
      return analysis;
    } catch (error) {
      logger.error('LLM analysis failed:', error);
      throw new Error('Failed to analyze code with LLM');
    }
  }

  parseJsonResponse(content) {
    try {
      // First try direct JSON parsing
      return JSON.parse(content);
    } catch (error) {
      // If that fails, try to extract JSON from markdown code blocks
      const jsonMatch = content.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
      if (jsonMatch) {
        return JSON.parse(jsonMatch[1]);
      }
      
      // Try to find JSON object without code blocks
      const jsonObjectMatch = content.match(/\{[\s\S]*\}/);
      if (jsonObjectMatch) {
        return JSON.parse(jsonObjectMatch[0]);
      }
      
      // If all parsing fails, return a default structure
      logger.warn('Could not parse LLM response as JSON, using fallback');
      return {
        score: 50,
        approved: false,
        issues: [{ type: 'parsing', severity: 'major', message: 'Could not parse LLM response', line: 1 }],
        security_concerns: [],
        performance_issues: [],
        suggestions: ['Review LLM response format']
      };
    }
  }

  async postReviewComments(repository, prNumber, issues) {
    const [owner, repo] = repository.split('/');
    
    try {
      for (const issue of issues) {
        if (issue.severity === 'critical' || issue.severity === 'major') {
          await this.github.pulls.createReviewComment({
            owner,
            repo,
            pull_number: prNumber,
            body: `**${issue.severity.toUpperCase()}**: ${issue.message}`,
            commit_sha: await this.getLatestCommitSha(owner, repo, prNumber),
            path: issue.file || 'unknown',
            line: issue.line || 1
          });
        }
      }
    } catch (error) {
      logger.error('Failed to post review comments:', error);
    }
  }

  async getLatestCommitSha(owner, repo, prNumber) {
    try {
      const { data: pr } = await this.github.pulls.get({
        owner,
        repo,
        pull_number: prNumber
      });
      return pr.head.sha;
    } catch (error) {
      logger.error('Failed to get commit SHA:', error);
      return 'unknown';
    }
  }
}

module.exports = new CodeReviewAgent();